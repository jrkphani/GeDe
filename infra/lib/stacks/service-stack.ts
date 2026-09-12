import * as cdk from 'aws-cdk-lib';
import {
  aws_certificatemanager as acm,
  aws_ec2 as ec2,
  aws_ecr_assets as ecr_assets,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_logs as logs,
  type aws_rds as rds,
  aws_route53 as route53,
  type aws_s3 as s3,
  type aws_ses as ses,
} from 'aws-cdk-lib';
import { type Construct } from 'constructs';

import { type EnvConfig } from '../config.js';
import { PLACEHOLDER_SYNC_DIR, REPO_ROOT, SYNC_DOCKERFILE, repoFileExists } from '../paths.js';

export interface ServiceStackProps extends cdk.StackProps {
  readonly config: EnvConfig;
  readonly hostedZoneId: string;
  readonly vpc: ec2.IVpc;
  readonly database: rds.DatabaseInstance;
  readonly dbSecurityGroup: ec2.ISecurityGroup;
  readonly docsBucket: s3.IBucket;
  readonly emailIdentity: ses.IEmailIdentity;
  readonly userPoolId: string;
  readonly userPoolClientId: string;
}

const CONTAINER_PORT = 3000;
const DB_PORT = 5432;

/**
 * The sync/API service: one ARM64 Fargate task behind an internet-facing ALB that
 * terminates TLS for api.<domain> and ws.<domain>.
 */
export class ServiceStack extends cdk.Stack {
  readonly alb: elbv2.ApplicationLoadBalancer;
  readonly service: ecs.FargateService;
  readonly apiUrl: cdk.CfnOutput;

  constructor(scope: Construct, id: string, props: ServiceStackProps) {
    super(scope, id, props);
    const { config, vpc, database } = props;

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: props.hostedZoneId,
      zoneName: config.domain,
    });

    const certificate = new acm.Certificate(this, 'Certificate', {
      domainName: `api.${config.domain}`,
      subjectAlternativeNames: [`ws.${config.domain}`],
      validation: acm.CertificateValidation.fromDns(zone),
    });

    // ---- Compute -------------------------------------------------------------------

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      containerInsightsV2: ecs.ContainerInsights.DISABLED,
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'Task', {
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const logGroup = new logs.LogGroup(this, 'Logs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    if (!database.secret) {
      throw new Error('DataStack must create the database with a generated secret');
    }
    const dbSecret = database.secret;

    taskDefinition.addContainer('sync', {
      image: this.syncImage(),
      portMappings: [{ containerPort: CONTAINER_PORT }],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'sync', logGroup }),
      secrets: {
        PGHOST: ecs.Secret.fromSecretsManager(dbSecret, 'host'),
        PGPORT: ecs.Secret.fromSecretsManager(dbSecret, 'port'),
        PGUSER: ecs.Secret.fromSecretsManager(dbSecret, 'username'),
        PGPASSWORD: ecs.Secret.fromSecretsManager(dbSecret, 'password'),
        PGDATABASE: ecs.Secret.fromSecretsManager(dbSecret, 'dbname'),
      },
      environment: {
        NODE_ENV: 'production',
        PORT: String(CONTAINER_PORT),
        PGSSLMODE: 'verify-full',
        PGSSLROOTCERT: '/app/rds-global-bundle.pem',
        COGNITO_USER_POOL_ID: props.userPoolId,
        COGNITO_CLIENT_ID: props.userPoolClientId,
        COGNITO_REGION: config.region,
        DOCS_BUCKET: props.docsBucket.bucketName,
        DOCS_PREFIX: 'docs/',
        WEB_ORIGIN: `https://${config.domain}`,
      },
    });

    // Least privilege: the docs prefix, its own database secret, and the domain's SES identity.
    props.docsBucket.grantReadWrite(taskDefinition.taskRole, 'docs/*');
    dbSecret.grantRead(taskDefinition.taskRole);
    props.emailIdentity.grantSendEmail(taskDefinition.taskRole);

    const serviceSg = new ec2.SecurityGroup(this, 'ServiceSecurityGroup', {
      vpc,
      description: 'GeDe sync service - admits only the ALB',
      allowAllOutbound: true,
    });

    // Public subnets + public IP because the VPC has no NAT (see NetworkStack).
    this.service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition,
      desiredCount: 1,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      circuitBreaker: { enable: true, rollback: true },
      healthCheckGracePeriod: cdk.Duration.seconds(90),
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [serviceSg],
    });

    this.service
      .autoScaleTaskCount({ minCapacity: 1, maxCapacity: 4 })
      .scaleOnCpuUtilization('Cpu', { targetUtilizationPercent: 60 });

    // `remoteRule: true` places the ingress rule in THIS stack (the peer's stack) so
    // DataStack never depends on ServiceStack.
    props.dbSecurityGroup.addIngressRule(
      serviceSg,
      ec2.Port.tcp(DB_PORT),
      'Postgres from the sync service',
      true,
    );

    // ---- Load balancer -----------------------------------------------------------

    const albSg = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc,
      description: 'GeDe ALB - HTTPS and HTTP (redirect) from the internet',
    });

    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: albSg,
      idleTimeout: cdk.Duration.seconds(3600),
      dropInvalidHeaderFields: true,
    });

    const https = this.alb.addListener('Https', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [elbv2.ListenerCertificate.fromCertificateManager(certificate)],
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
      open: true,
    });

    this.alb.addListener('Http', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: true,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true,
      }),
    });

    // Registering the service as a target also adds the ALB-SG → service-SG ingress on 3000.
    https.addTargets('Sync', {
      port: CONTAINER_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.service],
      healthCheck: {
        path: '/healthz',
        interval: cdk.Duration.seconds(30),
      },
      stickinessCookieDuration: cdk.Duration.hours(1),
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    this.apiUrl = new cdk.CfnOutput(this, 'ApiUrl', { value: `https://api.${config.domain}` });
  }

  /**
   * The sync image is built from the monorepo root so the Dockerfile can `COPY` workspace
   * packages and `infra/lib/rds-global-bundle.pem`. Only the asset hash is computed at synth;
   * the image itself is built by the pipeline's asset-publishing step (ARM CodeBuild).
   *
   * If `services/sync/Dockerfile` is absent (a local synth before that workspace exists) a
   * clearly labelled placeholder image is used so `cdk synth` and the unit tests still run.
   */
  private syncImage(): ecs.ContainerImage {
    if (!repoFileExists(SYNC_DOCKERFILE)) {
      cdk.Annotations.of(this).addWarningV2(
        'gede:placeholder-sync-image',
        `${SYNC_DOCKERFILE} not found; using infra/assets/placeholder/sync/Dockerfile. Do not deploy this.`,
      );
      return ecs.ContainerImage.fromAsset(PLACEHOLDER_SYNC_DIR, {
        file: 'Dockerfile',
        platform: ecr_assets.Platform.LINUX_ARM64,
      });
    }
    return ecs.ContainerImage.fromAsset(REPO_ROOT, {
      file: SYNC_DOCKERFILE,
      platform: ecr_assets.Platform.LINUX_ARM64,
      exclude: ['**/node_modules', '**/dist', '**/cdk.out', '.git', 'docs', 'apps', '**/*.test.ts'],
    });
  }
}
