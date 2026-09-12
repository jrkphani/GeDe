import * as cdk from 'aws-cdk-lib';
import {
  aws_ec2 as ec2,
  aws_rds as rds,
  aws_s3 as s3,
  aws_secretsmanager as secretsmanager,
} from 'aws-cdk-lib';
import { type Construct } from 'constructs';

import { type EnvConfig } from '../config.js';

export interface DataStackProps extends cdk.StackProps {
  readonly config: EnvConfig;
  readonly vpc: ec2.IVpc;
}

/** The least-privilege PostgreSQL login the running service uses (#36); the master user runs migrations only. */
export const DB_APP_USERNAME = 'gede_app';

/**
 * Stateful resources: the Postgres instance and the versioned documents bucket.
 * Both are protected against accidental deletion (see infra/CLAUDE.md for the teardown
 * procedure). Nothing in this stack references any other stage stack except Network.
 */
export class DataStack extends cdk.Stack {
  readonly database: rds.DatabaseInstance;
  readonly dbSecurityGroup: ec2.SecurityGroup;
  readonly docsBucket: s3.Bucket;
  /**
   * `gede/<env>/db-app`: `{ username, password }` for the runtime role. Nothing in AWS
   * creates the role — the migration runner does, as the master user on every boot,
   * reading this secret's password from `PGAPPPASSWORD` (packages/db/src/migrate.ts).
   * Rotation is therefore "put a new password, force a new deployment" (runbook §3).
   */
  readonly appSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    // Ingress is granted from the ServiceStack (remote rule), never here, so that this
    // stack has no dependency on the service.
    this.dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSecurityGroup', {
      vpc: props.vpc,
      description: 'GeDe Postgres - admits only the sync service security group',
      allowAllOutbound: false,
    });

    this.database = new rds.DatabaseInstance(this, 'Postgres', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_17 }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.BURSTABLE4_GRAVITON,
        ec2.InstanceSize.MICRO,
      ),
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      multiAz: false,
      backupRetention: cdk.Duration.days(7),
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
      storageEncrypted: true,
      publiclyAccessible: false,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.dbSecurityGroup],
      databaseName: 'gede',
      credentials: rds.Credentials.fromGeneratedSecret('gede_admin'),
      caCertificate: rds.CaCertificate.RDS_CA_RSA2048_G1,
    });

    // Named so the runbook can address it; a deleted secret name is unavailable for the
    // recovery window, which is fine because the stack itself is never torn down casually.
    this.appSecret = new secretsmanager.Secret(this, 'AppUser', {
      secretName: `gede/${props.config.envName}/db-app`,
      description:
        'GeDe least-privilege Postgres role for the running service (not the RDS master)',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: DB_APP_USERNAME }),
        generateStringKey: 'password',
        passwordLength: 48,
        // libpq-safe: no quoting or URI-reserved characters in the password.
        excludePunctuation: true,
      },
    });

    this.docsBucket = new s3.Bucket(this, 'Docs', {
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      // Architecture digest §1.7.3: "S3 docs versioning with 90-day noncurrent retention".
      // A superseded snapshot (a newer compaction, or the delete marker a purge writes)
      // is kept 90 days for point-in-time restore, then expires — so what the nightly
      // purge removes is actually gone after 90 days, and its delete marker with it. A
      // transition to Glacier IR at the same age would be pointless (S3 refuses an
      // expiration that is not later than a transition), so there is none.
      lifecycleRules: [
        {
          id: 'noncurrent-expire-90d',
          noncurrentVersionExpiration: cdk.Duration.days(90),
          expiredObjectDeleteMarker: true,
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
    });

    new cdk.CfnOutput(this, 'DocsBucketName', { value: this.docsBucket.bucketName });
  }
}
