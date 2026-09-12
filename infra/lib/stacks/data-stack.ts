import * as cdk from 'aws-cdk-lib';
import { aws_ec2 as ec2, aws_rds as rds, aws_s3 as s3 } from 'aws-cdk-lib';
import { type Construct } from 'constructs';

export interface DataStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;
}

/**
 * Stateful resources: the Postgres instance and the versioned documents bucket.
 * Both are protected against accidental deletion (see infra/CLAUDE.md for the teardown
 * procedure). Nothing in this stack references any other stage stack except Network.
 */
export class DataStack extends cdk.Stack {
  readonly database: rds.DatabaseInstance;
  readonly dbSecurityGroup: ec2.SecurityGroup;
  readonly docsBucket: s3.Bucket;

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

    this.docsBucket = new s3.Bucket(this, 'Docs', {
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'noncurrent-to-glacier-ir',
          noncurrentVersionTransitions: [
            {
              storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
        },
      ],
    });

    new cdk.CfnOutput(this, 'DocsBucketName', { value: this.docsBucket.bucketName });
  }
}
