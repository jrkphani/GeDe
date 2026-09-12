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
  readonly targetGroup: elbv2.ApplicationTargetGroup;
  readonly database: rds.DatabaseInstance;
  /** The jobs task (`--job purge`) and where to run it: the service's cluster, subnets and security group. */
  readonly cluster: ecs.ICluster;
  readonly jobsTaskDefinition: ecs.FargateTaskDefinition;
  readonly jobsLogGroup: logs.ILogGroup;
  readonly serviceSecurityGroup: ec2.ISecurityGroup;
}

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** Local time of the nightly purge (LIB-08); the retention window is measured on the database clock. */
export const PURGE_SCHEDULE = { hour: '2', minute: '30', timeZone: cdk.TimeZone.ASIA_SINGAPORE };

/**
 * Hours without a `job finished` line from the purge before `gede-<env>-purge-never-ran`
 * fires: the schedule is daily, so 26 leaves two hours for a late or retried run.
 */
export const PURGE_SILENCE_HOURS = 26;

/**
 * Day-one guardrails (architecture digest §1.7.3, reviewed 2026-09-13 — runbook "Ops
 * review"): CPU and memory of the one task, healthy targets, ALB 5xx ratio and p90 latency,
 * RDS free storage, burst credits and memory, a monthly budget on actual and forecast spend
 * — all fanning out to one email subscription. Plus the nightly purge schedule, the alert
 * that fires when its task exits non-zero, and the one that fires when it has not run at all.
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

    // One task of 1 GiB holds every open room in memory; past 80 % the next document opened
    // can OOM it, and the circuit breaker only helps a *deployment*, not a running task.
    const memoryAlarm = props.service
      .metricMemoryUtilization({ period })
      .createAlarm(this, 'ServiceMemory', {
        alarmName: `gede-${config.envName}-service-memory`,
        alarmDescription:
          'Sync service memory above 80% for 10 minutes (rooms held in memory; OOM risk)',
        threshold: 80,
        evaluationPeriods: 2,
        datapointsToAlarm: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    memoryAlarm.addAlarmAction(notify);

    // With one task, "no healthy target" is the outage. The 5xx ratio needs requests to
    // fire; this one does not.
    const healthyAlarm = props.targetGroup.metrics
      .healthyHostCount({ period: cdk.Duration.minutes(1), statistic: 'Minimum' })
      .createAlarm(this, 'NoHealthyTarget', {
        alarmName: `gede-${config.envName}-no-healthy-target`,
        alarmDescription: 'No healthy sync task behind the ALB for 3 minutes',
        threshold: 1,
        evaluationPeriods: 3,
        datapointsToAlarm: 3,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      });
    healthyAlarm.addAlarmAction(notify);

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

    // p90 of what the task answers in (REST and the upgrade handshake; open sockets do not
    // count). The API's own budget is well under a second; 2 s for 15 minutes is a task or
    // database in trouble, not a slow request.
    const latencyAlarm = props.alb.metrics
      .targetResponseTime({ period, statistic: 'p90' })
      .createAlarm(this, 'AlbLatency', {
        alarmName: `gede-${config.envName}-alb-latency`,
        alarmDescription: 'ALB target response time p90 above 2 s for 15 minutes',
        threshold: 2,
        evaluationPeriods: 3,
        datapointsToAlarm: 3,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    latencyAlarm.addAlarmAction(notify);

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

    // db.t4g.micro is burstable: with the credit balance gone it runs at baseline (10 % of
    // one vCPU) and every query slows without an error anywhere. A full balance is 144.
    const creditAlarm = props.database
      .metric('CPUCreditBalance', { period, statistic: 'Minimum' })
      .createAlarm(this, 'DbCpuCredits', {
        alarmName: `gede-${config.envName}-db-cpu-credits`,
        alarmDescription:
          'RDS CPU credit balance below 20 for 15 minutes (db.t4g.micro about to be throttled to baseline)',
        threshold: 20,
        evaluationPeriods: 3,
        datapointsToAlarm: 3,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    creditAlarm.addAlarmAction(notify);

    const dbMemoryAlarm = props.database
      .metricFreeableMemory({ period, statistic: 'Minimum' })
      .createAlarm(this, 'DbFreeableMemory', {
        alarmName: `gede-${config.envName}-db-freeable-memory`,
        alarmDescription:
          'RDS freeable memory below 100 MiB for 15 minutes (db.t4g.micro has 1 GiB)',
        threshold: 100 * MIB,
        evaluationPeriods: 3,
        datapointsToAlarm: 3,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    dbMemoryAlarm.addAlarmAction(notify);

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
    // documents it could not remove or a database failure that way) or that never started.
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
    // `purge could not remove every document` / `job failed` before exiting 1), so a
    // dashboard can show it and the alarm history keeps a record per night.
    const purgeFailures = new logs.MetricFilter(this, 'PurgeFailures', {
      logGroup: props.jobsLogGroup,
      metricNamespace: 'GeDe/Jobs',
      metricName: 'PurgeFailures',
      filterPattern: logs.FilterPattern.any(
        logs.FilterPattern.stringValue('$.msg', '=', 'purge could not remove every document'),
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
          'The nightly purge job logged a failure (documents it could not remove, or a database error)',
        threshold: 0,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    purgeAlarm.addAlarmAction(notify);

    // The job's last line (`main.ts`: `job finished` with `job: 'purge'` and the exit code)
    // as a run counter, so a scheduler that stops invoking, a task that never starts, or a
    // job that hangs is noticed: no run in PURGE_SILENCE_HOURS is an alarm. Missing data is
    // breaching on purpose — a silent log group is exactly the condition. Expect this alarm
    // to sit in ALARM from a fresh deploy until the first nightly run.
    const purgeRuns = new logs.MetricFilter(this, 'PurgeRuns', {
      logGroup: props.jobsLogGroup,
      metricNamespace: 'GeDe/Jobs',
      metricName: 'PurgeRuns',
      filterPattern: logs.FilterPattern.all(
        logs.FilterPattern.stringValue('$.msg', '=', 'job finished'),
        logs.FilterPattern.stringValue('$.job', '=', 'purge'),
      ),
      metricValue: '1',
    });
    const purgeNeverRan = purgeRuns
      .metric({ period: cdk.Duration.hours(1), statistic: 'Sum' })
      .createAlarm(this, 'PurgeNeverRan', {
        alarmName: `gede-${config.envName}-purge-never-ran`,
        alarmDescription: `The nightly purge has not logged a finished run in ${String(PURGE_SILENCE_HOURS)} hours (scheduler, task start or a hung job)`,
        threshold: 1,
        evaluationPeriods: PURGE_SILENCE_HOURS,
        datapointsToAlarm: PURGE_SILENCE_HOURS,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      });
    purgeNeverRan.addAlarmAction(notify);

    // `NotificationsWithSubscribers` is create-only on AWS::Budgets::Budget, so any change
    // replaces the resource — and a replacement under the same BudgetName fails ("same name
    // but a different internalId already exists", execution 3ea4807b). The name therefore
    // carries a revision: bump it whenever the notifications change, so CloudFormation
    // creates the new budget before deleting the old one.
    new budgets.CfnBudget(this, 'Budget', {
      budget: {
        budgetName: `gede-${config.envName}-monthly-r2`,
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
        // The forecast says it before the bill does (2026-09-13: US$128 forecast on a US$100
        // budget while the actual was at 53 %, and nothing had said so).
        {
          notification: {
            notificationType: 'FORECASTED',
            comparisonOperator: 'GREATER_THAN',
            threshold: 100,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [{ subscriptionType: 'EMAIL', address: config.alertsEmail }],
        },
      ],
    });
  }
}
