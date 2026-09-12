import * as cdk from 'aws-cdk-lib';
import {
  aws_budgets as budgets,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cw_actions,
  aws_ec2 as ec2,
  type aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_events as events,
  aws_events_targets as event_targets,
  aws_logs as logs,
  type aws_rds as rds,
  aws_scheduler as scheduler,
  aws_scheduler_targets as scheduler_targets,
  aws_sns as sns,
  aws_sns_subscriptions as subscriptions,
} from 'aws-cdk-lib';
import { type Construct } from 'constructs';

import { type EnvConfig } from '../config.js';

export interface OpsStackProps extends cdk.StackProps {
  readonly config: EnvConfig;
  readonly service: ecs.FargateService;
  readonly alb: elbv2.ApplicationLoadBalancer;
  readonly database: rds.DatabaseInstance;
  /** The jobs task (`--job purge`) and where to run it: the service's cluster, subnets and security group. */
  readonly cluster: ecs.ICluster;
  readonly jobsTaskDefinition: ecs.FargateTaskDefinition;
  readonly jobsLogGroup: logs.ILogGroup;
  readonly serviceSecurityGroup: ec2.ISecurityGroup;
}

const GIB = 1024 ** 3;

/** Local time of the nightly purge (LIB-08); the retention window is measured on the database clock. */
export const PURGE_SCHEDULE = { hour: '2', minute: '30', timeZone: cdk.TimeZone.ASIA_SINGAPORE };

/**
 * Day-one guardrails (architecture digest §1.7.3): CPU, 5xx ratio, free storage, and a
 * monthly budget, all fanning out to one email subscription. Plus the nightly purge
 * schedule and the alert that fires when its task exits non-zero.
 */
export class OpsStack extends cdk.Stack {
  readonly alertsTopic: sns.Topic;
  readonly purgeSchedule: scheduler.Schedule;

  constructor(scope: Construct, id: string, props: OpsStackProps) {
    super(scope, id, props);
    const { config, alb } = props;
    const period = cdk.Duration.minutes(5);

    this.alertsTopic = new sns.Topic(this, 'Alerts', {
      displayName: `GeDe ${config.envName} alerts`,
    });
    this.alertsTopic.addSubscription(new subscriptions.EmailSubscription(config.alertsEmail));
    const notify = new cw_actions.SnsAction(this.alertsTopic);

    const cpuAlarm = props.service
      .metricCpuUtilization({ period })
      .createAlarm(this, 'ServiceCpu', {
        alarmName: `gede-${config.envName}-service-cpu`,
        alarmDescription: 'Sync service CPU above 60% for 10 minutes (growth step 1 trigger)',
        threshold: 60,
        evaluationPeriods: 2,
        datapointsToAlarm: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    cpuAlarm.addAlarmAction(notify);

    const errorRatio = new cloudwatch.MathExpression({
      label: 'ALB 5xx ratio (%)',
      expression: '100 * (elb5xx + target5xx) / requests',
      usingMetrics: {
        elb5xx: alb.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, { period }),
        target5xx: alb.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { period }),
        requests: alb.metrics.requestCount({ period }),
      },
      period,
    });
    const errorAlarm = errorRatio.createAlarm(this, 'Alb5xx', {
      alarmName: `gede-${config.envName}-alb-5xx`,
      alarmDescription: 'More than 1% of ALB requests answered 5xx (load balancer or target)',
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    errorAlarm.addAlarmAction(notify);

    const storageAlarm = props.database
      .metricFreeStorageSpace({ period })
      .createAlarm(this, 'DbFreeStorage', {
        alarmName: `gede-${config.envName}-db-free-storage`,
        alarmDescription: 'RDS free storage below 5 GiB (25% of the 20 GB volume)',
        threshold: 5 * GIB,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    storageAlarm.addAlarmAction(notify);

    // ---- Nightly purge (LIB-08) ------------------------------------------------------
    // EventBridge Scheduler runs the jobs task definition once a night on the
    // service's cluster, in the public subnets with a public IP (no NAT, see
    // NetworkStack) and behind the service security group so it reaches RDS.
    // `EcsRunFargateTask` grants the scheduler role ecs:RunTask + iam:PassRole
    // on exactly this task definition.

    this.purgeSchedule = new scheduler.Schedule(this, 'NightlyPurge', {
      scheduleName: `gede-${config.envName}-nightly-purge`,
      description: 'Permanently delete documents soft-deleted more than 30 days ago (LIB-08)',
      schedule: scheduler.ScheduleExpression.cron(PURGE_SCHEDULE),
      target: new scheduler_targets.EcsRunFargateTask(props.cluster, {
        taskDefinition: props.jobsTaskDefinition,
        vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        assignPublicIp: true,
        securityGroups: [props.serviceSecurityGroup],
        // A purge that runs twice is harmless (idempotent) but one that never runs is
        // an alert we would not see; a single retry within the hour is enough.
        retryAttempts: 1,
        maxEventAge: cdk.Duration.hours(1),
      }),
    });

    // Alert on any stopped jobs task whose container exited non-zero (the job reports
    // orphaned S3 objects or a database failure that way) or that never started.
    const family = props.jobsTaskDefinition.family;
    const purgeFailed = new events.Rule(this, 'PurgeTaskFailed', {
      ruleName: `gede-${config.envName}-purge-task-failed`,
      description:
        'A jobs task (nightly purge) stopped with a non-zero exit code or failed to start',
      eventPattern: {
        source: ['aws.ecs'],
        detailType: ['ECS Task State Change'],
        detail: {
          clusterArn: [props.cluster.clusterArn],
          lastStatus: ['STOPPED'],
          taskDefinitionArn: [
            {
              prefix: cdk.Arn.format(
                { service: 'ecs', resource: 'task-definition', resourceName: `${family}:` },
                this,
              ),
            },
          ],
          $or: [
            { containers: { exitCode: [{ 'anything-but': 0 }] } },
            { stopCode: ['TaskFailedToStart'] },
          ],
        },
      },
    });
    purgeFailed.addTarget(
      new event_targets.SnsTopic(this.alertsTopic, {
        message: events.RuleTargetInput.fromText(
          [
            `GeDe ${config.envName}: the nightly purge task failed.`,
            `Task: ${events.EventField.fromPath('$.detail.taskArn')}`,
            `Stop code: ${events.EventField.fromPath('$.detail.stopCode')}`,
            `Reason: ${events.EventField.fromPath('$.detail.stoppedReason')}`,
            'See docs/RUNBOOK.md "Nightly purge".',
          ].join('\n'),
        ),
      }),
    );

    // The same failure as a metric, from the job's own log lines (`main.ts` logs
    // `purge left orphaned snapshot objects` / `job failed` before exiting 1), so a
    // dashboard can show it and the alarm history keeps a record per night.
    const purgeFailures = new logs.MetricFilter(this, 'PurgeFailures', {
      logGroup: props.jobsLogGroup,
      metricNamespace: 'GeDe/Jobs',
      metricName: 'PurgeFailures',
      filterPattern: logs.FilterPattern.any(
        logs.FilterPattern.stringValue('$.msg', '=', 'purge left orphaned snapshot objects'),
        logs.FilterPattern.stringValue('$.msg', '=', 'job failed'),
      ),
      metricValue: '1',
      defaultValue: 0,
    });
    const purgeAlarm = purgeFailures
      .metric({ period: cdk.Duration.hours(1), statistic: 'Sum' })
      .createAlarm(this, 'PurgeFailed', {
        alarmName: `gede-${config.envName}-purge-failed`,
        alarmDescription:
          'The nightly purge job logged a failure (orphaned S3 objects or a database error)',
        threshold: 0,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    purgeAlarm.addAlarmAction(notify);

    new budgets.CfnBudget(this, 'Budget', {
      budget: {
        budgetName: `gede-${config.envName}-monthly`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: config.budgetUsd, unit: 'USD' },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 80,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [{ subscriptionType: 'EMAIL', address: config.alertsEmail }],
        },
      ],
    });
  }
}
