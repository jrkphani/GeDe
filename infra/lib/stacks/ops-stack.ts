import * as cdk from 'aws-cdk-lib';
import {
  aws_budgets as budgets,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cw_actions,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_events as events,
  aws_iam as iam,
  type aws_lambda as lambda,
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
  /**
   * The jobs task by *family* and roles, never by task definition: its revision changes on
   * every deploy and a weak cross-stack reference to it is resolved once and never
   * refreshed (#97, ADR-036). The family name is a string; role ARNs are stable.
   */
  readonly jobsFamily: string;
  readonly jobsTaskRole: iam.IRole;
  readonly jobsExecutionRole: iam.IRole;
  readonly jobsLogGroup: logs.ILogGroup;
  /** The sync service's log group: the guided-sample seeder reports failures there (ONB-01). */
  readonly serviceLogGroup: logs.ILogGroup;
  readonly serviceSecurityGroup: ec2.ISecurityGroup;
  /** The pool's pre-authentication trigger: an error there refuses a sign-in (#103). */
  readonly preAuthFunction: lambda.IFunction;
  /** The pool's custom-message trigger: an error there is a stock, English code mail at best. */
  readonly customMessageFunction: lambda.IFunction;
}

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** A Fargate task definition family as the scheduler needs it: the ARN without a revision and the roles every revision uses. */
interface TaskFamily {
  readonly arn: string;
  readonly taskRole: iam.IRole;
  readonly executionRole: iam.IRole;
}

interface EcsRunFamilyTaskProps extends scheduler_targets.ScheduleTargetBaseProps {
  readonly cluster: ecs.ICluster;
  readonly family: TaskFamily;
  readonly vpcSubnets: ec2.SubnetSelection;
  readonly securityGroups: readonly ec2.ISecurityGroup[];
  readonly assignPublicIp: boolean;
}

/**
 * `RunTask` on Fargate for a task definition named by *family*. The L2 `EcsRunFargateTask`
 * takes a concrete `TaskDefinition` and renders its revisioned ARN into both the target and
 * the role's `ecs:RunTask` grant — the coupling that broke the purge (#97, ADR-036). Here
 * the target ARN is the family ARN, which `RunTask` resolves to the latest ACTIVE revision
 * at each invocation; IAM evaluates that resolved ARN, so `ecs:RunTask` is granted on
 * `<family>:*`, and `iam:PassRole` on the two roles for ECS only.
 */
class EcsRunFamilyTask extends scheduler_targets.ScheduleTargetBase {
  constructor(private readonly props: EcsRunFamilyTaskProps) {
    super(props, props.cluster.clusterArn);
  }

  protected addTargetActionToRole(role: iam.IRole): void {
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'RunAnyRevision',
        actions: ['ecs:RunTask'],
        resources: [`${this.props.family.arn}:*`],
      }),
    );
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'PassTaskRoles',
        actions: ['iam:PassRole'],
        resources: [this.props.family.taskRole.roleArn, this.props.family.executionRole.roleArn],
        conditions: { StringLike: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
      }),
    );
  }

  protected override bindBaseTargetConfig(
    schedule: scheduler.ISchedule,
  ): scheduler.ScheduleTargetConfig {
    const { cluster, family, vpcSubnets, securityGroups, assignPublicIp } = this.props;
    return {
      ...super.bindBaseTargetConfig(schedule),
      ecsParameters: {
        taskDefinitionArn: family.arn,
        launchType: ecs.LaunchType.FARGATE,
        networkConfiguration: {
          awsvpcConfiguration: {
            assignPublicIp: assignPublicIp ? 'ENABLED' : 'DISABLED',
            subnets: cluster.vpc.selectSubnets(vpcSubnets).subnetIds,
            securityGroups: securityGroups.map((sg) => sg.securityGroupId),
          },
        },
      },
    };
  }
}

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
    // The subscription is created pending; a person confirms it from the mail SNS sends
    // (runbook §8). Nothing here re-sends that mail.
    this.alertsTopic.addSubscription(new subscriptions.EmailSubscription(config.alertsEmail));
    this.grantPublishers(this.alertsTopic);
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
    // EventBridge Scheduler runs the jobs task family once a night on the service's
    // cluster, in the public subnets with a public IP (no NAT, see NetworkStack) and
    // behind the service security group so it reaches RDS. The target is the family ARN
    // — no revision — because every deploy registers a new revision and deregisters the
    // old one; a schedule pinned to a revision ran once against a deregistered definition
    // and was dropped (#97). `EcsRunFamilyTask` above scopes the role's IAM the same way.

    const family = props.jobsFamily;
    const familyArn = cdk.Arn.format(
      { service: 'ecs', resource: 'task-definition', resourceName: family },
      this,
    );
    const jobsFamily: TaskFamily = {
      arn: familyArn,
      taskRole: props.jobsTaskRole,
      executionRole: props.jobsExecutionRole,
    };

    this.purgeSchedule = new scheduler.Schedule(this, 'NightlyPurge', {
      scheduleName: `gede-${config.envName}-nightly-purge`,
      description: 'Permanently delete documents soft-deleted more than 30 days ago (LIB-08)',
      schedule: scheduler.ScheduleExpression.cron(PURGE_SCHEDULE),
      target: new EcsRunFamilyTask({
        cluster: props.cluster,
        family: jobsFamily,
        vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        assignPublicIp: true,
        securityGroups: [props.serviceSecurityGroup],
        // A purge that runs twice is harmless (idempotent) but one that never runs is
        // an alert we would not see; a single retry within the hour is enough.
        retryAttempts: 1,
        maxEventAge: cdk.Duration.hours(1),
      }),
    });

    // The failure #97 was: the scheduler could not even start the task, so no ECS event
    // and no log line existed to alarm on, and the run was dropped after its retry.
    // `InvocationDroppedCount` is that outcome as a metric (ScheduleGroup is the only
    // dimension; this is the group's only schedule).
    const purgeDropped = new cloudwatch.Metric({
      namespace: 'AWS/Scheduler',
      metricName: 'InvocationDroppedCount',
      dimensionsMap: { ScheduleGroup: 'default' },
      period: cdk.Duration.hours(1),
      statistic: 'Sum',
    }).createAlarm(this, 'PurgeInvocationDropped', {
      alarmName: `gede-${config.envName}-purge-invocation-dropped`,
      alarmDescription:
        'EventBridge Scheduler gave up invoking the nightly purge (RunTask refused, e.g. a bad task definition or IAM); no task ran',
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    purgeDropped.addAlarmAction(notify);

    // Alert on any stopped jobs task whose container exited non-zero (the job reports
    // documents it could not remove or a database failure that way) or that never started.
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
    // Not `event_targets.SnsTopic`: that target grants `events.amazonaws.com` on the topic
    // unconditionally, and the first such statement replaced SNS's default policy — which
    // is what let same-account CloudWatch alarms publish — so every alarm action failed
    // (#98). The topic policy is written once, in `grantPublishers`, with conditions.
    purgeFailed.addTarget({
      bind: () => ({
        id: '',
        arn: this.alertsTopic.topicArn,
        targetResource: this.alertsTopic,
        input: events.RuleTargetInput.fromText(
          [
            `GeDe ${config.envName}: the nightly purge task failed.`,
            `Task: ${events.EventField.fromPath('$.detail.taskArn')}`,
            `Stop code: ${events.EventField.fromPath('$.detail.stopCode')}`,
            `Reason: ${events.EventField.fromPath('$.detail.stoppedReason')}`,
            'See docs/RUNBOOK.md "Nightly purge".',
          ].join('\n'),
        ),
      }),
    });

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

    // ONB-01: a guided-sample seed that fails never fails the account's request — the
    // service answers `sampleDocumentId: null`, logs `guided sample seed failed` and retries
    // on the next request (`services/sync/src/sample.ts`). That line is the metric, so a
    // degraded S3 or a refused insert is seen rather than silently leaving new accounts
    // without the tour's sample.
    const sampleSeedFailures = new logs.MetricFilter(this, 'SampleSeedFailures', {
      logGroup: props.serviceLogGroup,
      metricNamespace: 'GeDe/Sync',
      metricName: 'SampleSeedFailures',
      filterPattern: logs.FilterPattern.stringValue('$.msg', '=', 'guided sample seed failed'),
      metricValue: '1',
      defaultValue: 0,
    });
    const sampleSeedAlarm = sampleSeedFailures
      .metric({ period: cdk.Duration.minutes(5), statistic: 'Sum' })
      .createAlarm(this, 'SampleSeedFailed', {
        alarmName: `gede-${config.envName}-sample-seed-failed`,
        alarmDescription:
          'The sync service could not seed a guided sample workscape for a new account (S3 put or insert failed); the account is served without it and retries on its next request',
        threshold: 0,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    sampleSeedAlarm.addAlarmAction(notify);

    // AUTH-04: the pre-authentication trigger runs on every sign-in, and an unhandled error
    // there is a refused sign-in. It now survives a failed client lookup for everyone but
    // the e2e account (#103); anything it still throws unexpectedly is an outage in the
    // making and is reported at the first occurrence.
    const preAuthErrors = props.preAuthFunction
      .metricErrors({ period: cdk.Duration.minutes(1), statistic: 'Sum' })
      .createAlarm(this, 'PreAuthErrors', {
        alarmName: `gede-${config.envName}-pre-auth-errors`,
        alarmDescription:
          'The Cognito pre-authentication trigger threw: a refused sign-in — the e2e account or client used outside the pipeline — or a fault in the trigger; read GeDe-Prod-Auth-PreAuthLogs',
        threshold: 0,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    preAuthErrors.addAlarmAction(notify);

    // AUTH-03/04, I18N-05: the custom-message trigger renders every one-time code. It
    // fails open (the pool's en-US template goes out instead), so an `Errors` datapoint
    // means the handler itself did not run — a broken bundle, a runtime fault — and
    // people are getting the floor, not the localised mail. Reported at the first one.
    const customMessageErrors = props.customMessageFunction
      .metricErrors({ period: cdk.Duration.minutes(1), statistic: 'Sum' })
      .createAlarm(this, 'CustomMessageErrors', {
        alarmName: `gede-${config.envName}-custom-message-errors`,
        alarmDescription:
          'The Cognito custom-message trigger threw: one-time codes are going out with the pool’s en-US template instead of the localised one; read GeDe-Prod-Auth-CustomMessageLogs',
        threshold: 0,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    customMessageErrors.addAlarmAction(notify);

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

  /**
   * The topic's access policy, in one place. Attaching any policy replaces SNS's default
   * one — the statement that lets same-account principals, CloudWatch alarms among them,
   * publish — so it is restated here (`AccountOwner`), and each service that publishes
   * is named with `aws:SourceAccount` and `aws:SourceArn` conditions so no other
   * account's alarm, rule or budget can post here (#98, #116). Budgets is granted for
   * when the budget's subscribers move to the topic; today they are direct email.
   */
  private grantPublishers(topic: sns.Topic): void {
    const sourceAccount = { StringEquals: { 'aws:SourceAccount': this.account } };
    const service = (sid: string, principal: string, sourceArn: string): iam.PolicyStatement =>
      new iam.PolicyStatement({
        sid,
        principals: [new iam.ServicePrincipal(principal)],
        actions: ['sns:Publish'],
        resources: [topic.topicArn],
        conditions: { ...sourceAccount, ArnLike: { 'aws:SourceArn': sourceArn } },
      });

    topic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AccountOwner',
        principals: [new iam.AnyPrincipal()],
        actions: [
          'sns:GetTopicAttributes',
          'sns:SetTopicAttributes',
          'sns:AddPermission',
          'sns:RemovePermission',
          'sns:DeleteTopic',
          'sns:Subscribe',
          'sns:ListSubscriptionsByTopic',
          'sns:Publish',
        ],
        resources: [topic.topicArn],
        conditions: { StringEquals: { 'AWS:SourceOwner': this.account } },
      }),
    );
    topic.addToResourcePolicy(
      service(
        'CloudWatchAlarms',
        'cloudwatch.amazonaws.com',
        cdk.Arn.format(
          {
            service: 'cloudwatch',
            resource: 'alarm',
            resourceName: '*',
            arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
          },
          this,
        ),
      ),
    );
    topic.addToResourcePolicy(
      service(
        'EventBridgeRules',
        'events.amazonaws.com',
        cdk.Arn.format({ service: 'events', resource: 'rule', resourceName: '*' }, this),
      ),
    );
    topic.addToResourcePolicy(
      service(
        'Budgets',
        'budgets.amazonaws.com',
        cdk.Arn.format(
          { service: 'budgets', region: '', resource: 'budget', resourceName: '*' },
          this,
        ),
      ),
    );
  }
}
