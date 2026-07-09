import { Stack, StackProps, CfnOutput, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';

export interface DataStackProps extends StackProps {
  /** The Network stack's VPC - cross-stack reference (issue 030 scope item 4). */
  vpc: ec2.IVpc;
}

/**
 * `Gede-Test-Data` - the v2 backend's managed Postgres (issue 030, ADR-0008,
 * scope item 2).
 *
 * RDS PostgreSQL 17, `db.t4g.micro`, placed in the Network stack's
 * `PRIVATE_ISOLATED` ("isolated") subnets - no route to the internet at all,
 * `publiclyAccessible: false`. Storage is encrypted at rest; automated
 * backups are enabled with a retained-snapshot removal policy (a final
 * snapshot survives `cdk destroy`, docs/DEPLOYMENT.md §9/§10). Credentials
 * are generated straight into Secrets Manager - never a standing secret in
 * the repo, mirroring issue 029's no-standing-secrets stance.
 *
 * Runs the identical Drizzle migration history as v1's in-browser PGlite
 * (src/db/migrations/*.sql, applied verbatim - no dialect fork, ADR-0008) -
 * proven by deploy/migration-parity/check-migrations.sh in CI, not by this
 * stack itself.
 *
 * Security-group note: this stack creates the database security group with
 * ZERO ingress rules - no `0.0.0.0/0`, not even from the compute tier yet.
 * The single permitted rule (compute SG -> 5432) is added by the *Api*
 * stack (see api-stack.ts), referencing this SG's id as a forward value.
 * Doing it that way (Api depends on Data, never the reverse) avoids a
 * circular `Data <-> Api` stack dependency that would otherwise result from
 * Data's template needing to import a security group id that only exists
 * once Api has been synthesized.
 *
 * **Issue 058 — logical replication parameter group.** ElectricSQL's read
 * path requires Postgres `wal_level = logical` (a STATIC parameter — RDS can
 * only apply it via a non-default DB parameter group, and static parameters
 * require a database REBOOT to take effect, unlike dynamic ones). This stack
 * now attaches a custom `rds.ParameterGroup` with `rds.logical_replication`,
 * `max_replication_slots`, and `max_wal_senders` set.
 *
 * ⚠️ DEPLOY-TIME IMPACT, FLAGGED EXPLICITLY (issue 058 risk callout, CLAUDE.md
 * "senior dev override" — surface, don't silently absorb): on an
 * ALREADY-DEPLOYED `test` RDS instance (docs/DEPLOYMENT.md §9a — this
 * instance is live, not a fresh create), attaching this parameter group for
 * the first time changes a STATIC parameter, which forces `cdk deploy` to
 * REBOOT the database — a brief write/connect outage for the live write-path
 * Lambda (issues 043/046) and the sync engine, not a zero-downtime change.
 * This is NOT something `cdk synth` can detect or avoid; it is a live-deploy
 * concern the orchestrator must plan around (e.g. a maintenance window),
 * never assume "just another `cdk deploy`".
 */
export class DataStack extends Stack {
  public readonly database: rds.DatabaseInstance;
  public readonly databaseSecurityGroup: ec2.SecurityGroup;
  public readonly parameterGroup: rds.ParameterGroup;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    this.databaseSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc: props.vpc,
      description:
        `${id} RDS Postgres - ingress restricted to the Api compute security group only (issue 030). ` +
        'No 0.0.0.0/0 rule is ever added to this security group; the one permitted rule is added by the Api stack.',
      // RDS never needs to *initiate* outbound network traffic through this
      // ENI's security group (management/backups go via the AWS control
      // plane, not through SG egress) - least privilege, no egress rule.
      allowAllOutbound: false,
    });

    // Issue 058 — logical replication is a prerequisite for ElectricSQL's
    // read path (node_modules/@electric-sql/client/skills/electric-
    // deployment: "CRITICAL Not setting wal_level to logical... Requires
    // Postgres restart after change"). `rds.logical_replication` (RDS's own
    // parameter name for `wal_level=logical`) and `max_wal_senders` are both
    // STATIC on RDS Postgres (pending-reboot, not applied live) —
    // `max_replication_slots` is also treated as static here for the same
    // reboot-on-first-apply reason. See this class's doc comment above for
    // the live-deploy reboot impact this causes on an already-running
    // instance.
    this.parameterGroup = new rds.ParameterGroup(this, 'LogicalReplicationParameterGroup', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_17 }),
      description: `${id} Postgres 17 - enables logical replication for ElectricSQL's read path (issue 058).`,
      parameters: {
        'rds.logical_replication': '1',
        max_replication_slots: '10',
        max_wal_senders: '10',
      },
    });

    this.database = new rds.DatabaseInstance(this, 'Database', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_17 }),
      // `db.t4g.micro` (issue 030 scope) - smallest Graviton burstable tier,
      // the accepted starting size per ADR-0008's ~$30-60/mo v2 cost target.
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE4_GRAVITON, ec2.InstanceSize.MICRO),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.databaseSecurityGroup],
      credentials: rds.Credentials.fromGeneratedSecret('gede_admin'),
      databaseName: 'gede',
      allocatedStorage: 20,
      storageEncrypted: true,
      publiclyAccessible: false,
      // Cost guard (mirrors the network stack's single-NAT guard): single-AZ
      // for the `test` env. A `prod` env should revisit Multi-AZ for HA.
      multiAz: false,
      backupRetention: Duration.days(7),
      // A final snapshot survives `cdk destroy` - the "retained snapshot
      // policy" half of issue 030's backup requirement (the other half,
      // automated/point-in-time backups, is `backupRetention` above).
      removalPolicy: RemovalPolicy.SNAPSHOT,
      deletionProtection: false, // test env: allow teardown (docs/DEPLOYMENT.md §10); a snapshot is still retained.
      // Issue 058 — see this class's doc comment for the live-deploy reboot
      // impact of attaching this for the first time on an already-running
      // instance.
      parameterGroup: this.parameterGroup,
    });

    new CfnOutput(this, 'DatabaseEndpoint', {
      value: this.database.dbInstanceEndpointAddress,
      exportName: `${id}-DatabaseEndpoint`,
      description: 'RDS endpoint address - isolated-subnet only, no public route.',
    });
    new CfnOutput(this, 'DatabaseSecretArn', {
      value: this.database.secret?.secretArn ?? 'unavailable',
      exportName: `${id}-DatabaseSecretArn`,
      description:
        'Secrets Manager ARN holding the generated DB credentials - consumed by the 032 (sync) / 033 (auth) Fargate task definitions.',
    });
  }
}
