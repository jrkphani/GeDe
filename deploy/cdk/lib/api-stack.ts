import { Stack, StackProps, CfnOutput, Duration } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
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
}

/**
 * `Gede-Test-Api` - the v2 compute tier (issue 030, ADR-0008, scope item 3):
 * an internet-facing ALB in the public subnets, fronting an ECS Fargate
 * cluster running two *stubbed* services in the private (NAT-egress)
 * subnets:
 *
 *   - `sync` - filled in by issue 032 (ElectricSQL sync container)
 *   - `auth` - filled in by issue 033 (better-auth, self-hosted)
 *
 * Both slots run the same clearly-marked placeholder image
 * (`public.ecr.aws/docker/library/nginx:alpine`) behind path-based ALB
 * routing (`/sync*`, `/auth*`), each with its own container healthcheck and
 * ALB target-group health check wired end-to-end. This is a documented,
 * health-checked placeholder tier, NOT a real implementation of either
 * service - 032/033 swap the image (+ container port, if it differs from
 * nginx's 80) without needing to re-architect the ALB/service/healthcheck
 * plumbing built here.
 *
 * Security groups: internet (`0.0.0.0/0:80`) -> ALB SG -> compute SG (both
 * stub services) -> the Data stack's RDS SG on 5432 (the ingress rule for
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
  public readonly authService: ecs.FargateService;

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
      description: `${id} Fargate compute (sync/auth stub slots, issue 030) - ingress only from the ALB security group.`,
      allowAllOutbound: true, // NAT egress: pulling container images now; outbound calls for the real 032/033 services later.
    });
    this.computeSecurityGroup.addIngressRule(
      this.albSecurityGroup,
      ec2.Port.tcp(80),
      'ALB -> Fargate services (placeholder container port 80).',
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
        'Api compute (sync/auth stub slots, issue 030) -> Postgres 5432 - the ONLY ingress rule on the Data security group. Never 0.0.0.0/0.',
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
          `${id}: no route matched (placeholder tier, issue 030) - /sync* and /auth* are stubbed pending issues 032/033.`,
      }),
    });

    // --- Placeholder container image ----------------------------------------
    // 032 (ElectricSQL sync) and 033 (better-auth) replace this image - the
    // task/service/target-group/health-check plumbing below is built to
    // survive that swap unchanged.
    const placeholderImage = ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/nginx:alpine');

    const sync = this.buildStubService('Sync', placeholderImage);
    const auth = this.buildStubService('Auth', placeholderImage);
    this.syncService = sync.service;
    this.authService = auth.service;

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

    listener.addTargets('AuthTargets', {
      priority: 20,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/auth*'])],
      port: 80,
      targets: [auth.service],
      healthCheck: {
        path: '/',
        interval: Duration.seconds(30),
        healthyHttpCodes: '200-399',
      },
    });

    new CfnOutput(this, 'LoadBalancerDnsName', {
      value: this.loadBalancer.loadBalancerDnsName,
      description: 'Api ALB DNS name - issue 040/033 later fronts this with a real domain + TLS.',
    });
  }

  /**
   * Builds one stubbed Fargate service (`sync` or `auth`): a task definition
   * with a container healthcheck, running the placeholder image, deployed
   * in the private (NAT-egress) subnets behind the compute security group.
   * 032/033 replace the image passed in; everything else here is meant to
   * be the real, permanent shape of the service.
   */
  private buildStubService(
    name: 'Sync' | 'Auth',
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
