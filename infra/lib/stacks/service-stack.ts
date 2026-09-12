import * as cdk from 'aws-cdk-lib';
import {
  aws_certificatemanager as acm,
  aws_ec2 as ec2,
  aws_ecr_assets as ecr_assets,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_iam as iam,
  aws_logs as logs,
  type aws_rds as rds,
  aws_route53 as route53,
  type aws_s3 as s3,
  type aws_secretsmanager as secretsmanager,
  type aws_ses as ses,
} from 'aws-cdk-lib';
import { type Construct } from 'constructs';

import { type EnvConfig } from '../config.js';
import { PLACEHOLDER_SYNC_DIR, REPO_ROOT, SYNC_DOCKERFILE, repoFileExists } from '../paths.js';
import { ACCESS_LOG_PREFIXES, ORIGIN_VERIFY_HEADER } from './web-stack.js';

export interface ServiceStackProps extends cdk.StackProps {
  readonly config: EnvConfig;
  readonly hostedZoneId: string;
  readonly vpc: ec2.IVpc;
  readonly database: rds.DatabaseInstance;
  /** `{ username, password }` of the least-privilege runtime role (#36), from DataStack. */
  readonly dbAppSecret: secretsmanager.ISecret;
  readonly dbSecurityGroup: ec2.ISecurityGroup;
  readonly docsBucket: s3.IBucket;
  readonly emailIdentity: ses.IEmailIdentity;
  readonly userPoolId: string;
  /** App clients whose tokens the service accepts: the SPA's and the pipeline's `gede-e2e` client. */
  readonly userPoolClientIds: readonly string[];
  /** Accepted `X-Origin-Verify` values, from WebStack (all generations). */
  readonly originVerifySecrets: readonly secretsmanager.ISecret[];
  /** WebStack's access-logs bucket; the ALB writes under `alb/` (#113). */
  readonly logsBucket: s3.IBucket;
}

const CONTAINER_PORT = 3000;
const DB_PORT = 5432;
/** Object-key prefix the service owns in the docs bucket; matches `DOCS_PREFIX` below. */
const DOCS_PREFIX = 'docs/';

/**
 * Short git sha baked into the image as `GEDE_VERSION` (reported by the signed-in `/api/version`).
 * CodeBuild sets `CODEBUILD_RESOLVED_SOURCE_VERSION` on the Synth step; a laptop
 * synth gets `local`. Because it is a Docker build arg, the image asset hash
 * changes on every commit and every deploy builds a fresh image — accepted, so
 * the running version is always attributable (infra/CLAUDE.md).
 */
export function gedeVersion(env: NodeJS.ProcessEnv = process.env): string {
  const sha = env.CODEBUILD_RESOLVED_SOURCE_VERSION;
  return sha === undefined || sha === '' ? 'local' : sha.slice(0, 7);
}

/** The nightly purge (LIB-08): `node main.js --job purge` on the same image (services/sync/src/main.ts). */
export const PURGE_COMMAND = ['node', 'main.js', '--job', 'purge'];

/**
 * The sync/API service: one ARM64 Fargate task behind an internet-facing ALB that
 * terminates TLS for api.<domain> and ws.<domain>.
 *
 * The HTTPS listener is deny-by-default (fixed 403). `/ws/*` is forwarded as-is (the
 * WebSocket cannot go through CloudFront, ADR-010; the service verifies the JWT on every
 * upgrade). `/api/*` and `/healthz` are forwarded only when the request carries the
 * `X-Origin-Verify` header CloudFront adds, so the WAF cannot be bypassed by calling
 * `api.<domain>` directly (issue #33). Target-group health checks do not pass through the
 * listener, so the internal `/healthz` probe is unaffected.
 */
export class ServiceStack extends cdk.Stack {
  readonly alb: elbv2.ApplicationLoadBalancer;
  /** The sync service's target group (OpsStack alarms on its healthy host count). */
  readonly targetGroup: elbv2.ApplicationTargetGroup;
  readonly service: ecs.FargateService;
  readonly cluster: ecs.Cluster;
  readonly serviceSecurityGroup: ec2.SecurityGroup;
  readonly logGroup: logs.LogGroup;
  /** Same image, `--job purge` as its command; run by the EventBridge Scheduler in OpsStack. */
  readonly jobsTaskDefinition: ecs.FargateTaskDefinition;
  /**
   * What OpsStack needs to run the jobs task — and deliberately not the task definition
   * itself. Its revision changes on every deploy (the image carries the git sha), and a
   * weak cross-stack reference to a revisioned ARN is resolved once and never refreshed
   * (#97, ADR-036). The family is a plain string; the two roles are created once and keep
   * their ARNs across revisions.
   */
  readonly jobsFamily: string;
  readonly jobsTaskRole: iam.IRole;
  readonly jobsExecutionRole: iam.IRole;
  readonly jobsLogGroup: logs.LogGroup;
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

    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      containerInsightsV2: ecs.ContainerInsights.DISABLED,
    });
    const cluster = this.cluster;

    if (!database.secret) {
      throw new Error('DataStack must create the database with a generated secret');
    }
    const dbSecret = database.secret;
    const image = this.syncImage();

    const environment = {
      NODE_ENV: 'production',
      PORT: String(CONTAINER_PORT),
      PGSSLMODE: 'verify-full',
      PGSSLROOTCERT: '/app/rds-global-bundle.pem',
      COGNITO_USER_POOL_ID: props.userPoolId,
      COGNITO_CLIENT_IDS: props.userPoolClientIds.join(','),
      COGNITO_REGION: config.region,
      DOCS_BUCKET: props.docsBucket.bucketName,
      DOCS_PREFIX,
      WEB_ORIGIN: `https://${config.domain}`,
    };
    // Two database identities in every task (#36): the master user (`PG*`) runs the
    // migrations and bootstraps the app role at boot, then the runtime pool connects as
    // `PGAPPUSER` with DML only. Both are injected by the execution role; the process
    // refuses to start in production when `PGAPPUSER`/`PGAPPPASSWORD` are missing.
    const secrets = () => ({
      PGHOST: ecs.Secret.fromSecretsManager(dbSecret, 'host'),
      PGPORT: ecs.Secret.fromSecretsManager(dbSecret, 'port'),
      PGUSER: ecs.Secret.fromSecretsManager(dbSecret, 'username'),
      PGPASSWORD: ecs.Secret.fromSecretsManager(dbSecret, 'password'),
      PGDATABASE: ecs.Secret.fromSecretsManager(dbSecret, 'dbname'),
      PGAPPUSER: ecs.Secret.fromSecretsManager(props.dbAppSecret, 'username'),
      PGAPPPASSWORD: ecs.Secret.fromSecretsManager(props.dbAppSecret, 'password'),
    });
    // The service task keeps its generated family (a new family would replace the
    // deployed resource for nothing); the jobs family is named so alarms can match it.
    const newTaskDefinition = (id: string, family?: string) =>
      new ecs.FargateTaskDefinition(this, id, {
        ...(family === undefined ? {} : { family }),
        cpu: 512,
        memoryLimitMiB: 1024,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.ARM64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
      });
    // Least privilege for both task roles (issue #42), written as explicit statements because
    // `grantRead`/`grantReadWrite` render unconditioned `s3:List*`/`s3:GetBucket*` and
    // `s3:DeleteObject*`. What services/sync/src/s3.ts calls: GetObject, PutObject,
    // ListObjectsV2 under a document prefix, and DeleteObjects for a purge — on a versioned
    // bucket that writes delete markers (s3:DeleteObject), never removes a version
    // (s3:DeleteObjectVersion, denied explicitly). The DB secret is read by the *execution*
    // role to inject `PG*`; neither process calls Secrets Manager, so the task roles get no
    // grant on it. The jobs task (nightly purge) needs exactly the same set: it lists and
    // deletes a purged document's prefix.
    const grant = (taskDefinition: ecs.TaskDefinition) => {
      const taskRole = taskDefinition.taskRole;
      taskRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          sid: 'DocsObjects',
          actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
          resources: [props.docsBucket.arnForObjects(`${DOCS_PREFIX}*`)],
        }),
      );
      taskRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          sid: 'ListDocsPrefixOnly',
          actions: ['s3:ListBucket'],
          resources: [props.docsBucket.bucketArn],
          conditions: { StringLike: { 's3:prefix': [`${DOCS_PREFIX}*`] } },
        }),
      );
      taskRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          sid: 'NeverDeleteVersions',
          effect: iam.Effect.DENY,
          actions: ['s3:DeleteObjectVersion'],
          resources: [props.docsBucket.arnForObjects('*')],
        }),
      );
      // Share mail (SHARE-02): `SendEmail` only — the service never sends raw
      // MIME — on the domain identity, and only as the product's sender. The
      // sender is `no-reply@<WEB_ORIGIN host>` in `services/sync/src/mail`;
      // the condition pins it here so a bug there cannot spoof another address.
      taskRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          sid: 'ShareMail',
          actions: ['ses:SendEmail'],
          resources: [props.emailIdentity.emailIdentityArn],
          conditions: { StringEquals: { 'ses:FromAddress': `no-reply@${config.domain}` } },
        }),
      );
    };

    // ---- The service task ----------------------------------------------------------

    const taskDefinition = newTaskDefinition('Task');
    this.logGroup = new logs.LogGroup(this, 'Logs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    taskDefinition.addContainer('sync', {
      image,
      portMappings: [{ containerPort: CONTAINER_PORT }],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'sync', logGroup: this.logGroup }),
      secrets: secrets(),
      environment,
    });
    grant(taskDefinition);

    // ---- The jobs task (nightly purge, LIB-08) ---------------------------------------
    // Same image, config and permissions; the command selects the job and the
    // process exits when it is done. Its own log group keeps job output apart
    // from the service's, with the same one-month retention.

    this.jobsFamily = `gede-${config.envName}-jobs`;
    this.jobsTaskDefinition = newTaskDefinition('JobsTask', this.jobsFamily);
    this.jobsLogGroup = new logs.LogGroup(this, 'JobsLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.jobsTaskDefinition.addContainer('purge', {
      image,
      command: PURGE_COMMAND,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'purge', logGroup: this.jobsLogGroup }),
      secrets: secrets(),
      environment,
    });
    grant(this.jobsTaskDefinition);
    this.jobsTaskRole = this.jobsTaskDefinition.taskRole;
    // Exists already (secrets and awslogs need one); `obtain` only types it as present.
    this.jobsExecutionRole = this.jobsTaskDefinition.obtainExecutionRole();

    const serviceSg = new ec2.SecurityGroup(this, 'ServiceSecurityGroup', {
      vpc,
      description: 'GeDe sync service - admits only the ALB',
      allowAllOutbound: true,
    });
    this.serviceSecurityGroup = serviceSg;

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
      deletionProtection: true,
    });
    // Access logs to WebStack's bucket under `alb/` (#113). The L2 sets the attributes and
    // adds the regional ELB account's PutObject statements to that bucket's policy.
    this.alb.logAccessLogs(props.logsBucket, ACCESS_LOG_PREFIXES.alb);

    // Deny by default; the rules below open exactly two paths.
    const https = this.alb.addListener('Https', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [elbv2.ListenerCertificate.fromCertificateManager(certificate)],
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
      open: true,
      defaultAction: elbv2.ListenerAction.fixedResponse(403, {
        contentType: 'application/json',
        messageBody: '{"error":"forbidden"}',
      }),
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
    // With `conditions` this is a listener rule, not the default action.
    const syncTargets = https.addTargets('Sync', {
      port: CONTAINER_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.service],
      healthCheck: {
        path: '/healthz',
        interval: cdk.Duration.seconds(30),
      },
      // No stickiness: the API is stateless per request and the WebSocket is one connection
      // to one task by nature. A stickiness cookie only pinned users to a task and put
      // `AWSALB`/`AWSALBCORS` on every `/api` response (#116).
      deregistrationDelay: cdk.Duration.seconds(30),
      priority: 20,
      conditions: [
        elbv2.ListenerCondition.pathPatterns(['/api/*', '/healthz']),
        elbv2.ListenerCondition.httpHeader(
          ORIGIN_VERIFY_HEADER,
          // `{{resolve:secretsmanager:…}}` per generation, substituted at deploy time.
          props.originVerifySecrets.map((secret) => secret.secretValue.unsafeUnwrap()),
        ),
      ],
    });

    this.targetGroup = syncTargets;

    // The WebSocket goes straight to the ALB (ADR-010); JWT + permission checks happen on the
    // upgrade in services/sync/src/ws/route.ts.
    https.addAction('Ws', {
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/ws/*'])],
      action: elbv2.ListenerAction.forward([syncTargets]),
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
      buildArgs: { GEDE_VERSION: gedeVersion() },
      // Mirrors the root .dockerignore (which the asset fingerprint also honours) plus tests.
      exclude: [
        '**/node_modules',
        '**/dist',
        '**/cdk.out',
        '.git',
        '.claude',
        '**/.env',
        '**/.env.*',
        'docs',
        'apps',
        '**/*.test.ts',
      ],
    });
  }
}
