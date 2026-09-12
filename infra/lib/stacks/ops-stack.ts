import * as cdk from 'aws-cdk-lib';
import {
  aws_budgets as budgets,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cw_actions,
  type aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
  type aws_rds as rds,
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
}

const GIB = 1024 ** 3;

/**
 * Day-one guardrails (architecture digest §1.7.3): CPU, 5xx ratio, free storage, and a
 * monthly budget, all fanning out to one email subscription.
 */
export class OpsStack extends cdk.Stack {
  readonly alertsTopic: sns.Topic;

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
