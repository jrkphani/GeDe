import * as path from 'node:path';
import { Stack, StackProps, CfnOutput, CustomResource, Duration } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

// Amazon RDS global CA bundle (deploy/cdk/lib/rds-global-bundle.pem) — copied
// into the write Lambda's bundle so albAdapter.ts can verify the RDS server
// cert (ssl.rejectUnauthorized:true). Shared with migration-stack.ts's runner
// and, as of issue 058, the shape-proxy Lambda below too.
const RDS_CA_SOURCE = path.resolve(__dirname, 'rds-global-bundle.pem');

// Electric's own documented shape-endpoint port (node_modules/@electric-sql/
// client/skills/electric-deployment: `ports: ['3000:3000']`, healthcheck on
// `:3000/v1/health`) — a private, VPC-internal port; never exposed on the
// public ALB (see this stack's class doc, "Issue 058" section, for why).
const ELECTRIC_PORT = 3000;

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
  /**
   * The Auth stack's Cognito User Pool id (issue 046) - a cross-stack
   * reference used to derive `COGNITO_ISSUER` for the write-path Lambda
   * (and, as of issue 058, the shape-proxy Lambda too).
   * Never a hardcoded string or the issue-043 `PLACEHOLDER_USER_POOL_ID`
   * stub: if the User Pool ever changes, this reference re-resolves rather
   * than silently drifting.
   */
  userPoolId: string;
  /**
   * Issue 049 — enables the read-only db-inspection Lambda (its SG, its
   * NodejsFunction, its generated debug-token secret, and its `/debug/db/*`
   * ALB route). Undefined/false (the default) creates NONE of it — this is
   * how a future `prod` env stays exposure-free even if this stack is ever
   * instantiated for one; see build-app.ts/bin/gede.ts for where the actual
   * `test`-only gating decision is made.
   */
  debugApiEnabled?: boolean;
}

/**
 * `Gede-Test-Api` - the v2 compute tier (issue 030, ADR-0008, scope item 3):
 * an internet-facing ALB in the public subnets, fronting an ECS Fargate
 * cluster running one real service in the private (NAT-egress) subnets:
 *
 *   - `sync` - the real ElectricSQL image (issue 058; was an `nginx:alpine`
 *     placeholder through issue 030/032)
 *
 * The `auth` stub slot that originally lived here (better-auth, ADR-0008)
 * has been REMOVED (issue 033, ADR-0009): auth is now Amazon Cognito, a
 * managed regional resource outside the VPC (see `auth-stack.ts`), so there
 * is no auth Fargate service, target group, or `/auth*` ALB route to run
 * here anymore - one fewer always-on task.
 *
 * **Issue 058 — Electric is NOT reachable from the public ALB.** ElectricSQL's
 * own HTTP API has no per-request authorization of its own
 * (node_modules/@electric-sql/client/skills/electric-proxy-auth: "CRITICAL
 * Calling Electric directly from production client... Electric's HTTP API is
 * public by default with no auth. Always proxy through your server so the
 * server controls shape definitions and injects secrets."). Routing the raw
 * Electric container behind the internet-facing ALB's `/sync*` path — as a
 * more literal reading of "keep the existing ALB /sync* routing" might
 * suggest — would let ANY internet client read the entire multi-tenant
 * database by supplying an arbitrary `table`/`where`. This stack instead:
 *
 *   1. Runs Electric in the private compute subnets, registered on an
 *      internal Cloud Map DNS name (`sync.<namespace>`) reachable ONLY from
 *      inside the VPC — no ALB target group references it at all.
 *   2. Fronts `/sync*` on the SAME public ALB with a Lambda (`ShapeProxy`,
 *      issue 058) that verifies the caller's Cognito JWT, resolves their
 *      real workspace memberships (057's model) from Postgres, builds a
 *      workspace-scoped shape request (src/domain/syncScope.ts), and ONLY
 *      THEN forwards to Electric's private endpoint with `ELECTRIC_SECRET`
 *      attached. This mirrors the write-path Lambda's exact shape (043/046)
 *      and Electric's own documented proxy-auth pattern.
 *
 * Issue 049 adds a Lambda-behind-this-ALB slot, `test`-env-only: a read-only
 * db-inspection API under `/debug/db/*`, gated entirely on
 * `props.debugApiEnabled` (never created otherwise - a future `prod` env
 * never passes it). It exists purely for operator observability (confirming
 * a frontend write actually landed in RDS) and creates no additional
 * `ECS::Service`.
 *
 * Security groups: internet (`0.0.0.0/0:80`) -> ALB SG. The ALB no longer
 * has any network path to the compute SG (issue 058 — Electric moved off the
 * ALB entirely); instead the shape-proxy Lambda's own SG -> compute SG on
 * `ELECTRIC_PORT` is the only ingress the compute SG grants. Electric's own
 * egress to the Data stack's RDS SG on 5432 (the ingress rule for that hop
 * is added here - see the `databaseSecurityGroup` prop doc and
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
  public readonly writeApiFunction: lambda.Function;
  public readonly writeApiSecurityGroup: ec2.SecurityGroup;
  /** The dedicated `/accept` endpoint (issue 080) - a narrowly-scoped, server-authoritative Lambda for redeeming a pending invitation; see src/server/acceptInvite/handler.ts's own doc comment for why this is NOT routed through the generic write-path. */
  public readonly acceptApiFunction: lambda.Function;
  public readonly acceptApiSecurityGroup: ec2.SecurityGroup;
  /** The ElectricSQL shape-proxy (issue 058) - the ONLY thing the browser's `/sync*` requests ever reach; Electric itself is VPC-private. */
  public readonly shapeProxyFunction: lambda.Function;
  public readonly shapeProxySecurityGroup: ec2.SecurityGroup;
  /** The generated shared-secret Electric requires on every `/v1/shape` request (issue 058) - known only to the shape-proxy Lambda and Electric itself, never the browser. */
  public readonly electricSecret: secretsmanager.Secret;
  /** The read-only db-inspection API (issue 049) - undefined unless `debugApiEnabled` was passed. */
  public readonly debugApiFunction?: lambda.Function;
  public readonly debugApiSecurityGroup?: ec2.SecurityGroup;
  /** The generated shared-secret this API's callers must present via `x-debug-token`/bearer - Secrets Manager only, never the repo. */
  public readonly debugTokenSecret?: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    this.cluster = new ecs.Cluster(this, 'Cluster', { vpc: props.vpc });

    // --- Security groups --------------------------------------------------
    this.albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc: props.vpc,
      description:
        `${id} ALB - internet-facing. Fronts three Lambda targets (write-path, shape-proxy, ` +
        'optional debug/db) behind path-based routing; Electric itself is never an ALB target (issue 058).',
      allowAllOutbound: true,
    });
    this.albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Public ALB ingress - the only 0.0.0.0/0 rule in this stack, and the only one anywhere in the v2 backend (by design: only the ALB is internet-facing, DEPLOYMENT.md section 9).',
    );

    this.computeSecurityGroup = new ec2.SecurityGroup(this, 'ComputeSecurityGroup', {
      vpc: props.vpc,
      description:
        `${id} Fargate compute (the real ElectricSQL sync service, issue 058; auth moved to Cognito, issue 033) - ` +
        'ingress only from the shape-proxy Lambda security group (issue 058 - NOT from the ALB; Electric is never an ALB target).',
      allowAllOutbound: true, // NAT egress: pulling the Electric image, replicating to no external target, calling Secrets Manager.
    });

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
        'Api compute (the real Electric sync service, issue 058) to Postgres 5432 - the Electric logical-replication connection. Never 0.0.0.0/0.',
    });

    // --- ALB ----------------------------------------------------------------
    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: this.albSecurityGroup,
      // Issue 076: explicit (this was already the CDK/ALB default) so the
      // timeout ordering below is intentional and documented, not
      // incidental. Must stay >= the ShapeProxyFunction's 30s Lambda
      // timeout (this stack, below) so the ALB never cuts the connection
      // before the Lambda itself would.
      idleTimeout: Duration.seconds(60),
    });

    const listener = this.loadBalancer.addListener('HttpListener', {
      port: 80,
      open: false, // Ingress is already governed by albSecurityGroup above.
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: 'text/plain',
        messageBody:
          `${id}: no route matched. /sync* -> the shape-proxy Lambda (issue 058), /write* -> the write-path ` +
          'Lambda (issue 043/046). /auth* is intentionally absent - auth is Amazon Cognito (issue 033, ADR-0009).',
      }),
    });

    // --- Service discovery (issue 058) ---------------------------------------
    // Electric is never an ALB target (see this class's doc comment) - the
    // shape-proxy Lambda instead reaches it over a private Cloud Map DNS
    // name, resolvable only from inside this VPC. This is the standard
    // "same-VPC Lambda calls a private ECS service" pattern, lighter-weight
    // than standing up a SECOND, internal-only load balancer for one task.
    const serviceDiscoveryNamespace = new servicediscovery.PrivateDnsNamespace(this, 'ServiceDiscoveryNamespace', {
      name: 'gede.internal',
      vpc: props.vpc,
      description: `${id} private DNS namespace (issue 058) - resolves the Electric sync service's internal address for the shape-proxy Lambda.`,
    });

    // --- Electric's composed DATABASE_URL (issue 058) ------------------------
    // See deploy/cdk/lib/electric-db-url/handler.ts's header for why this
    // indirection exists: ECS's native `secrets:` resolution can only pull
    // ONE field out of the Data stack's generated {username,password} JSON
    // secret per env var, so a tiny one-shot custom-resource Lambda composes
    // the full `postgresql://user:pass@host:5432/db?sslmode=require` string
    // ONCE, into this dedicated secret, which Electric's task then reads as
    // a normal single-string `secrets:` entry - the composed value is never
    // baked into the CloudFormation template (unlike a `{{resolve:
    // secretsmanager:...}}` dynamic reference embedded in `environment`,
    // which WOULD be readable via `ecs:DescribeTaskDefinition`).
    const electricDatabaseUrlSecret = new secretsmanager.Secret(this, 'ElectricDatabaseUrlSecret', {
      description:
        `${id} Electric's composed DATABASE_URL (issue 058) - written by the ElectricDbUrlComposerFunction custom ` +
        'resource below; the initial CDK-generated value is never used (overwritten before the Electric task ever starts).',
    });

    const rootLockFile = path.resolve(__dirname, '..', '..', '..', 'package-lock.json');

    const electricDbUrlComposerFunction = new nodejs.NodejsFunction(this, 'ElectricDbUrlComposerFunction', {
      description: `${id} one-shot DATABASE_URL composer for the Electric task (issue 058) - reads the Data stack's RDS secret, writes a composed connection string into ElectricDatabaseUrlSecret.`,
      entry: path.resolve(__dirname, 'electric-db-url', 'handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 128,
      timeout: Duration.seconds(30),
      // No VPC attachment needed: this Lambda only calls the Secrets Manager
      // API (reachable over the internet by default, no RDS connection of
      // its own) - unlike every DB-querying Lambda elsewhere in this stack.
      depsLockFilePath: rootLockFile,
      environment: {
        DATABASE_SECRET_ARN: props.databaseSecret.secretArn,
        DATABASE_ENDPOINT: props.databaseEndpoint,
        TARGET_SECRET_ARN: electricDatabaseUrlSecret.secretArn,
      },
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'node20',
        forceDockerBundling: false,
        commandHooks: { beforeBundling: () => [], beforeInstall: () => [], afterBundling: () => [] },
      },
    });
    props.databaseSecret.grantRead(electricDbUrlComposerFunction);
    electricDatabaseUrlSecret.grantWrite(electricDbUrlComposerFunction);

    const electricDbUrlProvider = new cr.Provider(this, 'ElectricDbUrlProvider', {
      onEventHandler: electricDbUrlComposerFunction,
    });
    const electricDbUrlResource = new CustomResource(this, 'ElectricDbUrlResource', {
      serviceToken: electricDbUrlProvider.serviceToken,
      properties: {
        // Re-runs if the Data stack's secret ARN or endpoint ever changes
        // (e.g. an RDS replace) - otherwise a stable no-op on every deploy.
        DatabaseSecretArn: props.databaseSecret.secretArn,
        DatabaseEndpoint: props.databaseEndpoint,
      },
    });

    // --- Electric's own shared secret (issue 058) -----------------------------
    // Required in production (node_modules/@electric-sql/client/skills/
    // electric-deployment: "CRITICAL Running without ELECTRIC_SECRET in
    // production... refuses to start unless ELECTRIC_INSECURE=true is set").
    // Known only to Electric itself and the shape-proxy Lambda (which
    // attaches it to every forwarded request) - never the browser. Mirrors
    // issue 049's debug-token secret pattern exactly.
    this.electricSecret = new secretsmanager.Secret(this, 'ElectricSecret', {
      description: `${id} ElectricSQL's own API secret (issue 058) - required on every /v1/shape request; known only to Electric and the shape-proxy Lambda, generated by CDK, never committed to the repo.`,
      generateSecretString: { excludePunctuation: true, passwordLength: 40 },
    });

    // --- Real ElectricSQL Fargate service (issue 058) -------------------------
    // Replaces the nginx:alpine placeholder (issue 030).
    //
    // NOTE (issue 078 step 2): this task definition used to set
    // `ELECTRIC_FEATURE_FLAGS=allow_subqueries` — three of the nine synced
    // tables (tier2_entries/parameters/bindings) had no direct workspace_id
    // column, so their shape-scoping WHERE clause needed a subquery, an
    // "experimental" Electric feature. 078 diagnosed that experimental
    // subquery path's shape-cache churn as the root cause of Electric
    // serving stale/empty shapes to clients. Migration 0015 denormalized
    // workspace_id directly onto those three tables (see
    // src/domain/syncScope.ts), so every synced table now uses the same
    // simple literal predicate and this flag is no longer needed at all —
    // removed rather than left set-but-unused.
    const electricImage = ecs.ContainerImage.fromRegistry('electricsql/electric:1.7.7');
    // NOTE: PINNED (issue 078 step 1) to the exact build validated as
    // replicating live in issue 058 - was `:latest`, which silently drifts
    // to a different Electric build on every ECS task restart. That drift
    // is a reproducibility hazard around the experimental allow_subqueries
    // shape feature and was implicated in 078's stale/empty-shape bug.

    const electricTaskDefinition = new ecs.FargateTaskDefinition(this, 'SyncTaskDef', {
      cpu: 256,
      memoryLimitMiB: 512,
    });

    electricTaskDefinition.addContainer('SyncContainer', {
      image: electricImage,
      containerName: 'sync',
      portMappings: [{ containerPort: ELECTRIC_PORT, protocol: ecs.Protocol.TCP }],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'gede-sync' }),
      // NOTE (issue 078 step 2): this used to also set an `environment` block
      // with `ELECTRIC_FEATURE_FLAGS: 'allow_subqueries'` — see the
      // container-image comment above for why that's gone. Electric's
      // logical-replication requirement at the Postgres level
      // (data-stack.ts's ParameterGroup, issue 058) is unaffected — that was
      // never behind this flag.
      secrets: {
        // fromSecretsManager (not the *Version variant) resolves to the
        // CURRENT secret value at container launch — no pinned version id —
        // so this always reads whatever ElectricDbUrlComposerFunction most
        // recently wrote, without needing to know its version at synth time.
        DATABASE_URL: ecs.Secret.fromSecretsManager(electricDatabaseUrlSecret),
        ELECTRIC_SECRET: ecs.Secret.fromSecretsManager(this.electricSecret),
      },
      healthCheck: {
        command: ['CMD-SHELL', `curl -sf http://localhost:${ELECTRIC_PORT}/v1/health || exit 1`],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(30),
      },
    });

    // Construct id is 'ElectricSyncService', NOT 'SyncService' (deploy
    // attempt #4 postmortem): the previously-deployed service (issue 030)
    // under the logical id 'SyncService' was an nginx:alpine ALB target on
    // container port 80. Reusing that id here would make CloudFormation
    // attempt an in-place UPDATE of that live ECS::Service into this one -
    // no ALB target, Cloud-Map-only, port 3000 - which ECS rejects outright
    // ("The container sync did not have a container port 80 defined" /
    // "Task failed ELB health checks"), UPDATE_FAILED, full stack rollback.
    // A fresh logical id makes CloudFormation CREATE this service and
    // DELETE the old stub instead - the correct operation for this shape
    // change. (`this.syncService` and the Cloud Map name below stay 'sync'
    // - only the CFN logical id changes.)
    this.syncService = new ecs.FargateService(this, 'ElectricSyncService', {
      cluster: this.cluster,
      taskDefinition: electricTaskDefinition,
      // 1 always-on Electric task. Background: this was briefly staged at 0
      // to let the Api stack provision cleanly while we confirmed the DB's
      // logical replication was active (Electric requires wal_level=logical;
      // the Data stack's RDS ParameterGroup sets rds.logical_replication=1).
      // Verified live: rds.logical_replication=on / wal_level=logical were
      // already in effect (no reboot needed), and a scaled-up Electric task
      // connected, acquired the `electric_slot_default` replication slot, and
      // began streaming from Postgres cleanly. Restored to 1.
      desiredCount: 1,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [this.computeSecurityGroup],
      assignPublicIp: false,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      // Issue 058 - registers `sync.gede.internal` in the private DNS
      // namespace above, so the shape-proxy Lambda can reach Electric
      // without any ALB target group / public exposure at all.
      cloudMapOptions: {
        name: 'sync',
        cloudMapNamespace: serviceDiscoveryNamespace,
        dnsRecordType: servicediscovery.DnsRecordType.A,
      },
    });
    // Electric must not start accepting shape requests before its
    // DATABASE_URL secret has a real value (rather than the CDK-generated
    // placeholder) - an explicit CFN dependency, since there is no other
    // resource-graph edge between "a secret's VALUE was overwritten" and
    // "a Fargate service that reads it at container start".
    this.syncService.node.addDependency(electricDbUrlResource);

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

    // Real bundled handler (issue 046, following up on issue 043's deferred
    // inline 503 stub). `NodejsFunction` bundles `src/server/writeApi/albAdapter.ts`
    // (the AWS-specific adapter — jwt.ts/handler.ts/store.ts underneath it are
    // pure and already unit-tested) via esbuild, offline/no-Docker (esbuild is
    // a deploy/cdk devDependency, added by issue 043 for exactly this;
    // `forceDockerBundling: false` below makes that explicit rather than
    // implicit, keeping `cdk synth` deterministic — the issue 041 hazard this
    // stack previously sidestepped by staying inline). `COGNITO_ISSUER` is a
    // genuine cross-stack reference to the Auth stack's User Pool (below) —
    // never the `PLACEHOLDER_USER_POOL_ID` literal.
    //
    // Deploy-order note (see also migration-stack.ts's class doc): this
    // handler assumes issue 045's migrations have already applied the schema
    // (including 034's `app_user` role + RLS policies) to the RDS by the time
    // it serves its first write — a deploy-ORDER concern (045 -> 046 -> 047),
    // not something this stack enforces at synth time.
    const cognitoIssuer = `https://cognito-idp.${this.region}.amazonaws.com/${props.userPoolId}`;

    this.writeApiFunction = new nodejs.NodejsFunction(this, 'WriteApiFunction', {
      description: `${id} Tier-2 write-path API (issue 043/046, ADR-0010) - validates the Cognito JWT + workspace scope + domain invariants, then persists to Postgres as the least-privileged app_user role (034/045).`,
      entry: path.resolve(__dirname, '..', '..', '..', 'src', 'server', 'writeApi', 'albAdapter.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 256,
      timeout: Duration.seconds(10),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [this.writeApiSecurityGroup],
      depsLockFilePath: rootLockFile,
      environment: {
        // Cross-stack reference to the real Gede-Test-Auth User Pool (issue
        // 046) — never a hardcoded string or the issue-043 PLACEHOLDER.
        COGNITO_ISSUER: cognitoIssuer,
        DATABASE_SECRET_ARN: props.databaseSecret.secretArn,
        DATABASE_ENDPOINT: props.databaseEndpoint,
      },
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'node20',
        // Offline synth (issue 041 lesson) — esbuild is a deploy/cdk
        // devDependency (issue 043) specifically so this never needs Docker.
        forceDockerBundling: false,
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          // Copy Amazon's RDS CA bundle alongside the handler so albAdapter.ts
          // can verify the RDS server cert. Runs on the host (no Docker), so
          // the absolute source path is valid. Mirrors migration-stack.ts.
          afterBundling: (_inputDir: string, outputDir: string) => [
            `cp "${RDS_CA_SOURCE}" "${outputDir}/rds-global-bundle.pem"`,
          ],
        },
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

    // --- Accept-invite API (issue 080) ---------------------------------------
    // A dedicated, server-authoritative endpoint for redeeming a pending
    // invitation — see src/server/acceptInvite/handler.ts's own doc comment
    // for why this is NOT routed through the generic `/write` path (the
    // tenancy guard there gates a `workspace_members` insert on the caller
    // already being a member of the target workspace, which is necessarily
    // false for a first-time accept). Mirrors the write-path Lambda's exact
    // shape (VPC-attached, its own SG, RDS CA bundle, Cognito JWKS
    // verification) — this is a THIRD, independent least-privilege ingress
    // grant on the Data stack's Postgres SG, not a reuse of the write-path
    // Lambda's own SG, so each can be tightened/removed independently.
    this.acceptApiSecurityGroup = new ec2.SecurityGroup(this, 'AcceptApiSecurityGroup', {
      vpc: props.vpc,
      description: `${id} accept-invite Lambda (issue 080) - egress to Postgres (5432) and the internet (NAT, for Cognito JWKS) only; nothing ingresses to it over the network.`,
      allowAllOutbound: true,
    });

    new ec2.CfnSecurityGroupIngress(this, 'AllowAcceptApiToPostgres', {
      groupId: props.databaseSecurityGroup.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 5432,
      toPort: 5432,
      sourceSecurityGroupId: this.acceptApiSecurityGroup.securityGroupId,
      description: 'Accept-invite Lambda (issue 080) to Postgres 5432 - a fourth, distinct ingress rule on the Data security group (alongside the Fargate compute, write-path, and shape-proxy Lambda SG rules); still never 0.0.0.0/0.',
    });

    this.acceptApiFunction = new nodejs.NodejsFunction(this, 'AcceptApiFunction', {
      description: `${id} dedicated accept-invite API (issue 080) - verifies the Cognito JWT, loads the pending invite for the caller's VERIFIED email, and atomically seats the membership + marks the invite accepted.`,
      entry: path.resolve(__dirname, '..', '..', '..', 'src', 'server', 'acceptInvite', 'albAdapter.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 256,
      timeout: Duration.seconds(10),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [this.acceptApiSecurityGroup],
      depsLockFilePath: rootLockFile,
      environment: {
        COGNITO_ISSUER: cognitoIssuer,
        DATABASE_SECRET_ARN: props.databaseSecret.secretArn,
        DATABASE_ENDPOINT: props.databaseEndpoint,
      },
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'node20',
        forceDockerBundling: false,
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (_inputDir: string, outputDir: string) => [
            `cp "${RDS_CA_SOURCE}" "${outputDir}/rds-global-bundle.pem"`,
          ],
        },
      },
    });
    props.databaseSecret.grantRead(this.acceptApiFunction);

    const acceptApiTargetGroup = new elbv2.ApplicationTargetGroup(this, 'AcceptApiTargetGroup', {
      vpc: props.vpc,
      targetType: elbv2.TargetType.LAMBDA,
      targets: [new targets.LambdaTarget(this.acceptApiFunction)],
      // Same cost rationale as the write-path target group above - a single-
      // Lambda-target group with a periodic synthetic health check would
      // just burn invocations for no benefit.
      healthCheck: { enabled: false },
    });

    listener.addAction('AcceptApiRoute', {
      priority: 50,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/accept*'])],
      action: elbv2.ListenerAction.forward([acceptApiTargetGroup]),
    });

    // --- ElectricSQL shape-proxy (issue 058) ----------------------------------
    // The ONLY thing the browser's `/sync*` requests ever reach - see this
    // class's doc comment for why Electric itself is never an ALB target.
    // Mirrors the write-path Lambda's exact shape (VPC-attached, its own SG,
    // RDS CA bundle, Cognito JWKS verification) plus TWO new capabilities:
    // resolving the caller's workspace memberships (a `workspace_members`
    // SELECT, the read-path's counterpart to 057's `isMember` check) and
    // forwarding the scoped request to Electric's private Cloud Map address.
    this.shapeProxySecurityGroup = new ec2.SecurityGroup(this, 'ShapeProxySecurityGroup', {
      vpc: props.vpc,
      description: `${id} shape-proxy Lambda (issue 058) - egress to Postgres (5432, for workspace-membership lookups), the Electric private Cloud Map address (issue 058 - see the compute SG ingress rule below), and the internet (NAT, for Cognito JWKS).`,
      allowAllOutbound: true,
    });

    new ec2.CfnSecurityGroupIngress(this, 'AllowShapeProxyToPostgres', {
      groupId: props.databaseSecurityGroup.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 5432,
      toPort: 5432,
      sourceSecurityGroupId: this.shapeProxySecurityGroup.securityGroupId,
      description: 'Shape-proxy Lambda (issue 058) to Postgres 5432 - a third, distinct ingress rule on the Data security group (alongside the Fargate compute and write-path Lambda SG rules above); still never 0.0.0.0/0.',
    });

    // The shape-proxy Lambda is the ONLY thing permitted to reach Electric's
    // compute SG - replaces the pre-058 `albSecurityGroup -> computeSecurityGroup`
    // rule entirely (Electric is no longer an ALB target at all).
    this.computeSecurityGroup.addIngressRule(
      this.shapeProxySecurityGroup,
      ec2.Port.tcp(ELECTRIC_PORT),
      'Shape-proxy Lambda (issue 058) to the Electric shape endpoint - the ONLY ingress this security group grants; never the ALB.',
    );

    this.shapeProxyFunction = new nodejs.NodejsFunction(this, 'ShapeProxyFunction', {
      description: `${id} ElectricSQL shape-proxy (issue 058) - verifies the Cognito JWT, resolves the caller's workspace memberships, builds a workspace-scoped shape request, forwards to Electric's private endpoint.`,
      entry: path.resolve(__dirname, '..', '..', '..', 'src', 'server', 'shapeProxy', 'albAdapter.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 256,
      // Issue 076: Electric's `live=true` long-poll holds the connection
      // open ~20s before responding. This timeout MUST exceed that (was
      // 15s, which fired before Electric could respond, severing the
      // in-flight fetch -> ALB 502). Ordering: Electric ~20s < Lambda 30s
      // <= CloudFront readTimeout 60s (hosting-stack.ts's sync* origin);
      // Lambda 30s < ALB idle 60s (this stack's ApplicationLoadBalancer).
      timeout: Duration.seconds(30),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [this.shapeProxySecurityGroup],
      depsLockFilePath: rootLockFile,
      environment: {
        COGNITO_ISSUER: cognitoIssuer,
        DATABASE_SECRET_ARN: props.databaseSecret.secretArn,
        DATABASE_ENDPOINT: props.databaseEndpoint,
        // Electric's private Cloud Map address - never reachable from
        // outside this VPC (issue 058's whole point).
        ELECTRIC_INTERNAL_URL: `http://sync.${serviceDiscoveryNamespace.namespaceName}:${ELECTRIC_PORT}`,
        ELECTRIC_SECRET_ARN: this.electricSecret.secretArn,
      },
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'node20',
        forceDockerBundling: false,
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (_inputDir: string, outputDir: string) => [
            `cp "${RDS_CA_SOURCE}" "${outputDir}/rds-global-bundle.pem"`,
          ],
        },
      },
    });
    props.databaseSecret.grantRead(this.shapeProxyFunction);
    this.electricSecret.grantRead(this.shapeProxyFunction);

    const shapeProxyTargetGroup = new elbv2.ApplicationTargetGroup(this, 'ShapeProxyTargetGroup', {
      vpc: props.vpc,
      targetType: elbv2.TargetType.LAMBDA,
      targets: [new targets.LambdaTarget(this.shapeProxyFunction)],
      healthCheck: { enabled: false }, // Same cost rationale as the write-path target group above.
    });

    // Priority 20, NOT 10: the currently-live listener still has the issue-030
    // stub's `/sync*` rule at priority 10, and CloudFormation creates this new
    // rule before deleting the old one during the update — reusing priority 10
    // collides ("Priority '10' is currently in use"). 20 is free (live rules:
    // 10=old /sync*, 30=/write*, 40=/debug/db/*); once the old rule is deleted
    // this becomes the sole `/sync*` rule. Verified against the live listener.
    listener.addAction('ShapeProxyRoute', {
      priority: 20,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/sync*'])],
      action: elbv2.ListenerAction.forward([shapeProxyTargetGroup]),
    });

    // --- Debug/db inspection API (issue 049) ---------------------------------
    // A SECOND serverless Lambda behind this same ALB, `test`-env-only
    // (props.debugApiEnabled, gated upstream in bin/gede.ts/build-app.ts) -
    // gives the operator a secured, read-only view into the RDS instance so
    // a real frontend write's arrival in Postgres can be confirmed with a
    // single authenticated `curl`, instead of a one-off hand-built Lambda
    // (issue 049 motivation). Mirrors the write-path Lambda's VPC/SG/secret/
    // CA/bundling shape exactly (issue 046) - the only NEW AWS resource kind
    // here is the generated debug-token secret below. Entirely absent from
    // the synthesized template when the flag is off - including in `prod`,
    // which never passes it.
    if (props.debugApiEnabled) {
      this.debugTokenSecret = new secretsmanager.Secret(this, 'DebugTokenSecret', {
        description:
          `${id} debug/db inspection API shared secret (issue 049, test-env only) - every request must present this via ` +
          'the x-debug-token header (or an Authorization: Bearer token); missing/wrong is a 401. Generated by CDK, never committed to the repo.',
        generateSecretString: {
          excludePunctuation: true,
          passwordLength: 40,
        },
      });

      this.debugApiSecurityGroup = new ec2.SecurityGroup(this, 'DebugApiSecurityGroup', {
        vpc: props.vpc,
        description: `${id} debug/db inspection Lambda (issue 049, test-env only) - egress to Postgres (5432) only; nothing ingresses to it over the network.`,
        allowAllOutbound: true,
      });

      new ec2.CfnSecurityGroupIngress(this, 'AllowDebugApiToPostgres', {
        groupId: props.databaseSecurityGroup.securityGroupId,
        ipProtocol: 'tcp',
        fromPort: 5432,
        toPort: 5432,
        sourceSecurityGroupId: this.debugApiSecurityGroup.securityGroupId,
        description: 'Debug/db inspection Lambda (issue 049, test-env only) to Postgres 5432 - a fourth, distinct ingress rule on the Data security group; still never 0.0.0.0/0.',
      });

      this.debugApiFunction = new nodejs.NodejsFunction(this, 'DebugApiFunction', {
        description: `${id} read-only db-inspection API (issue 049, test-env only) - SELECT-only guard + read-only transaction + statement_timeout + row cap; secret-gated on every request.`,
        entry: path.resolve(__dirname, '..', '..', '..', 'src', 'server', 'debugApi', 'albAdapter.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        memorySize: 256,
        timeout: Duration.seconds(10),
        vpc: props.vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [this.debugApiSecurityGroup],
        depsLockFilePath: rootLockFile,
        environment: {
          DATABASE_SECRET_ARN: props.databaseSecret.secretArn,
          DATABASE_ENDPOINT: props.databaseEndpoint,
          DEBUG_TOKEN_SECRET_ARN: this.debugTokenSecret.secretArn,
        },
        bundling: {
          minify: true,
          sourceMap: false,
          target: 'node20',
          forceDockerBundling: false,
          commandHooks: {
            beforeBundling: () => [],
            beforeInstall: () => [],
            // Same RDS CA bundle the write-path Lambda copies in (issue 046) -
            // this handler verifies the same RDS server cert the same way.
            afterBundling: (_inputDir: string, outputDir: string) => [
              `cp "${RDS_CA_SOURCE}" "${outputDir}/rds-global-bundle.pem"`,
            ],
          },
        },
      });
      props.databaseSecret.grantRead(this.debugApiFunction);
      this.debugTokenSecret.grantRead(this.debugApiFunction);

      const debugApiTargetGroup = new elbv2.ApplicationTargetGroup(this, 'DebugApiTargetGroup', {
        vpc: props.vpc,
        targetType: elbv2.TargetType.LAMBDA,
        targets: [new targets.LambdaTarget(this.debugApiFunction)],
        // Same rationale as the write-path target group above - a single-
        // Lambda-target group with a periodic synthetic health check would
        // just burn invocations for no benefit.
        healthCheck: { enabled: false },
      });

      listener.addAction('DebugApiRoute', {
        priority: 40,
        conditions: [elbv2.ListenerCondition.pathPatterns(['/debug/db/*'])],
        action: elbv2.ListenerAction.forward([debugApiTargetGroup]),
      });

      new CfnOutput(this, 'DebugTokenSecretArn', {
        value: this.debugTokenSecret.secretArn,
        description:
          'Secrets Manager ARN of the debug/db inspection API\'s shared secret (issue 049) - fetch its value to call /debug/db/* via x-debug-token.',
      });
    }

    new CfnOutput(this, 'LoadBalancerDnsName', {
      value: this.loadBalancer.loadBalancerDnsName,
      description: 'Api ALB DNS name - issue 040/033 later fronts this with a real domain + TLS. /write* and /sync* route to Lambdas (043/046, 058); Electric itself is never directly reachable (issue 058).',
    });
  }
}
