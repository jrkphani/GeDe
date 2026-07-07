import * as path from 'path';
import { Stack, StackProps, CfnOutput, Duration } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface ApiStackProps extends StackProps {
  /** The Network stack's VPC - cross-stack reference (issue 030 scope item 4). */
  vpc: ec2.IVpc;
  /**
   * The Data stack's RDS security group. This stack (Api) adds the *one*
   * permitted ingress rule to it (compute SG -> 5432) as a forward
   * reference - see data-stack.ts's class doc for why the rule lives here
   * rather than there (avoids a circular Data<->Api stack dependency).
   */
  databaseSecurityGroup: ec2.ISecurityGroup;
  /** The Data stack's generated RDS credentials secret (issue 043 - the write-API Lambda reads this at cold start). */
  databaseSecret: secretsmanager.ISecret;
  /** The Data stack's RDS endpoint address (issue 043). */
  databaseEndpoint: string;
}

/**
 * `Gede-Test-Api` - the v2 compute tier (issue 030, ADR-0008, scope item 3):
 * an internet-facing ALB in the public subnets, fronting an ECS Fargate
 * cluster running one *stubbed* service in the private (NAT-egress)
 * subnets:
 *
 *   - `sync` - filled in by issue 032 (ElectricSQL sync container)
 *
 * The `auth` stub slot that originally lived here (better-auth, ADR-0008)
 * has been REMOVED (issue 033, ADR-0009): auth is now Amazon Cognito, a
 * managed regional resource outside the VPC (see `auth-stack.ts`), so there
 * is no auth Fargate service, target group, or `/auth*` ALB route to run
 * here anymore - one fewer always-on task.
 *
 * The remaining slot runs the same clearly-marked placeholder image
 * (`public.ecr.aws/docker/library/nginx:alpine`) behind path-based ALB
 * routing (`/sync*`), with its own container healthcheck and ALB
 * target-group health check wired end-to-end. This is a documented,
 * health-checked placeholder tier, NOT a real implementation of the service
 * - 032 swaps the image (+ container port, if it differs from nginx's 80)
 * without needing to re-architect the ALB/service/healthcheck plumbing
 * built here.
 *
 * Security groups: internet (`0.0.0.0/0:80`) -> ALB SG -> compute SG (the
 * sync stub service) -> the Data stack's RDS SG on 5432 (the ingress rule for
 * that last hop is added here - see the `databaseSecurityGroup` prop doc and
 * data-stack.ts's class doc for the circular-dependency rationale). No rule
 * anywhere in this stack admits `0.0.0.0/0` to port 5432.
 */
export class ApiStack extends Stack {
  public readonly cluster: ecs.Cluster;
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  public readonly computeSecurityGroup: ec2.SecurityGroup;
  public readonly albSecurityGroup: ec2.SecurityGroup;
  public readonly syncService: ecs.FargateService;
  /** The Tier-2 write-path API (issue 043, ADR-0010) - Lambda, not Fargate: `$0` idle, pay-per-write. */
  public readonly writeApiFunction: NodejsFunction;
  public readonly writeApiSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    this.cluster = new ecs.Cluster(this, 'Cluster', { vpc: props.vpc });

    // --- Security groups --------------------------------------------------
    this.albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc: props.vpc,
      description:
        `${id} ALB - internet-facing. Placeholder tier serves plain HTTP; ` +
        'a real domain + ACM cert (the Hosting/Dns seam, issue 040) upgrades this to HTTPS when 032/033 land.',
      allowAllOutbound: true,
    });
    this.albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Public ALB ingress - the only 0.0.0.0/0 rule in this stack, and the only one anywhere in the v2 backend (by design: only the ALB is internet-facing, DEPLOYMENT.md section 9).',
    );

    this.computeSecurityGroup = new ec2.SecurityGroup(this, 'ComputeSecurityGroup', {
      vpc: props.vpc,
      description: `${id} Fargate compute (sync stub slot, issue 030; auth moved to Cognito, issue 033) - ingress only from the ALB security group.`,
      allowAllOutbound: true, // NAT egress: pulling container images now; outbound calls for the real 032 service later.
    });
    this.computeSecurityGroup.addIngressRule(
      this.albSecurityGroup,
      ec2.Port.tcp(80),
      'ALB to Fargate services (placeholder container port 80).',
    );

    // The Data stack's RDS security group admits ONLY this compute security
    // group, on 5432 - added here (an L1 resource, scoped to *this* stack)
    // rather than by calling `databaseSecurityGroup.addIngressRule(...)`,
    // which would add the `AWS::EC2::SecurityGroupIngress` resource to the
    // *Data* stack's template and require Data to import this stack's SG id
    // - a reverse reference that would create a circular Data<->Api
    // dependency (Api already depends on Data for this very id). Using the
    // low-level Cfn resource here keeps the reference one-directional.
    new ec2.CfnSecurityGroupIngress(this, 'AllowComputeToPostgres', {
      groupId: props.databaseSecurityGroup.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 5432,
      toPort: 5432,
      sourceSecurityGroupId: this.computeSecurityGroup.securityGroupId,
      description:
        'Api compute (sync stub slot, issue 030) to Postgres 5432 - the ONLY ingress rule on the Data security group. Never 0.0.0.0/0.',
    });

    // --- ALB ----------------------------------------------------------------
    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: this.albSecurityGroup,
    });

    const listener = this.loadBalancer.addListener('HttpListener', {
      port: 80,
      open: false, // Ingress is already governed by albSecurityGroup above.
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: 'text/plain',
        messageBody:
          `${id}: no route matched (placeholder tier, issue 030) - /sync* is stubbed pending issue 032. ` +
          '/auth* is intentionally absent - auth is Amazon Cognito (issue 033, ADR-0009), not routed through this ALB.',
      }),
    });

    // --- Placeholder container image ----------------------------------------
    // 032 (ElectricSQL sync) replaces this image - the task/service/target-
    // group/health-check plumbing below is built to survive that swap
    // unchanged. There is no `auth` slot anymore (issue 033, ADR-0009).
    const placeholderImage = ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/nginx:alpine');

    const sync = this.buildStubService('Sync', placeholderImage);
    this.syncService = sync.service;

    listener.addTargets('SyncTargets', {
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/sync*'])],
      port: 80,
      targets: [sync.service],
      healthCheck: {
        path: '/',
        interval: Duration.seconds(30),
        healthyHttpCodes: '200-399',
      },
    });

    // --- Write-path API (issue 043, ADR-0010) --------------------------------
    // Serverless by design: a Lambda behind this same ALB, NOT a third
    // Fargate service - the cost/shape guard the test-first plan asks for
    // (`$0` idle, pay-per-write; only `sync` above is an always-on task).
    // The Lambda still needs VPC networking (private, NAT-egress subnets) to
    // reach RDS in the isolated tier and Cognito's JWKS endpoint over the
    // internet - unlike the ALB-Lambda invocation path itself (which never
    // touches this security group; ALB invokes Lambda via the Lambda service
    // API, not a network hop governed by albSecurityGroup).
    this.writeApiSecurityGroup = new ec2.SecurityGroup(this, 'WriteApiSecurityGroup', {
      vpc: props.vpc,
      description: `${id} write-path Lambda (issue 043) - egress to Postgres (5432) and the internet (NAT, for Cognito JWKS) only; nothing ingresses to it over the network.`,
      allowAllOutbound: true,
    });

    new ec2.CfnSecurityGroupIngress(this, 'AllowWriteApiToPostgres', {
      groupId: props.databaseSecurityGroup.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 5432,
      toPort: 5432,
      sourceSecurityGroupId: this.writeApiSecurityGroup.securityGroupId,
      description: 'Write-path Lambda (issue 043) to Postgres 5432 - a second, distinct ingress rule on the Data security group (alongside the Fargate compute SG rule above); still never 0.0.0.0/0.',
    });

    this.writeApiFunction = new NodejsFunction(this, 'WriteApiFunction', {
      description: `${id} Tier-2 write-path API (issue 043, ADR-0010) - validates the Cognito JWT + workspace scope + domain invariants, then persists to Postgres.`,
      entry: path.join(__dirname, '..', '..', '..', 'src', 'server', 'writeApi', 'albAdapter.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 256,
      timeout: Duration.seconds(10),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [this.writeApiSecurityGroup],
      depsLockFilePath: path.join(__dirname, '..', '..', '..', 'package-lock.json'),
      bundling: {
        // The Node 20 Lambda runtime ships its own AWS SDK v3 - excluding it
        // keeps the bundle small; everything else (jose, pg, drizzle-orm)
        // is bundled since it is NOT provided by the runtime.
        externalModules: ['@aws-sdk/*'],
      },
      environment: {
        // 033 (Cognito User Pool) has not shipped in this worktree yet - this
        // is a placeholder issuer, overwritten with the real User Pool issuer
        // URL once that stack exists (see docs/issues/033-auth-account.md).
        COGNITO_ISSUER: 'https://cognito-idp.us-east-1.amazonaws.com/PLACEHOLDER_USER_POOL_ID',
        DATABASE_SECRET_ARN: props.databaseSecret.secretArn,
        DATABASE_ENDPOINT: props.databaseEndpoint,
      },
    });
    props.databaseSecret.grantRead(this.writeApiFunction);

    const writeApiTargetGroup = new elbv2.ApplicationTargetGroup(this, 'WriteApiTargetGroup', {
      vpc: props.vpc,
      targetType: elbv2.TargetType.LAMBDA,
      targets: [new targets.LambdaTarget(this.writeApiFunction)],
      // Lambda ALB targets are billed per invocation - a periodic synthetic
      // health check would burn invocations for no benefit (Lambda's own
      // concurrency/retry model already handles availability). Disabled, as
      // AWS recommends for a single-Lambda-target target group.
      healthCheck: { enabled: false },
    });

    listener.addAction('WriteApiRoute', {
      priority: 30,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/write*'])],
      action: elbv2.ListenerAction.forward([writeApiTargetGroup]),
    });

    new CfnOutput(this, 'LoadBalancerDnsName', {
      value: this.loadBalancer.loadBalancerDnsName,
      description: 'Api ALB DNS name - issue 040/033 later fronts this with a real domain + TLS. /write* routes to the issue 043 write-path Lambda.',
    });
  }

  /**
   * Builds one stubbed Fargate service (`sync`): a task definition with a
   * container healthcheck, running the placeholder image, deployed in the
   * private (NAT-egress) subnets behind the compute security group. 032
   * replaces the image passed in; everything else here is meant to be the
   * real, permanent shape of the service.
   */
  private buildStubService(
    name: 'Sync',
    image: ecs.ContainerImage,
  ): { service: ecs.FargateService; taskDefinition: ecs.FargateTaskDefinition } {
    const taskDefinition = new ecs.FargateTaskDefinition(this, `${name}TaskDef`, {
      cpu: 256,
      memoryLimitMiB: 512,
    });

    taskDefinition.addContainer(`${name}Container`, {
      image,
      containerName: name.toLowerCase(),
      portMappings: [{ containerPort: 80, protocol: ecs.Protocol.TCP }],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: `gede-${name.toLowerCase()}` }),
      // Placeholder healthcheck against nginx's default page. 032/033
      // replace this with a real liveness command for Electric/better-auth.
      healthCheck: {
        command: ['CMD-SHELL', 'wget -qO- http://localhost/ || exit 1'],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(10),
      },
    });

    const service = new ecs.FargateService(this, `${name}Service`, {
      cluster: this.cluster,
      taskDefinition,
      desiredCount: 1, // Cost guard - single task per stub slot; 032/033 revisit sizing.
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [this.computeSecurityGroup],
      assignPublicIp: false,
      // Fail fast (not the ECS default 3h timeout) if the placeholder image
      // can't come up healthy, and allow one extra task during deploys so a
      // desiredCount:1 service isn't taken fully offline mid-rollout.
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    });

    return { service, taskDefinition };
  }
}
