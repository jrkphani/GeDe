import * as cdk from 'aws-cdk-lib';
import { type Construct } from 'constructs';

import { EDGE_REGION, type EnvConfig, appTags } from './config.js';
import { AuthStack } from './stacks/auth-stack.js';
import { DataStack } from './stacks/data-stack.js';
import { DnsStack } from './stacks/dns-stack.js';
import { EdgeStack } from './stacks/edge-stack.js';
import { NetworkStack } from './stacks/network-stack.js';
import { OpsStack } from './stacks/ops-stack.js';
import { ServiceStack } from './stacks/service-stack.js';
import { WebStack } from './stacks/web-stack.js';

export interface GedeStageProps extends cdk.StageProps {
  readonly config: EnvConfig;
  readonly hostedZoneId: string;
  readonly appleSignIn: boolean;
}

/**
 * One complete environment. Stack order is implied by construct references:
 *
 *   Network → Data ─────────────→ Service → Ops
 *             Auth ──→ Web ──────↗    ↘
 *   Edge (us-east-1) ↗    ↘──────────→ Dns
 *
 * Web precedes Service because Service's listener rule accepts the origin-verify header
 * values Web generates and CloudFront presents (ADR-018): on a rotation CloudFront starts
 * sending the new value before the ALB stops accepting the old one.
 *
 * Stack names are `GeDe-<envName>-<Name>`; the stage id is only a construct-tree prefix.
 */
export class GedeStage extends cdk.Stage {
  readonly apiUrl: cdk.CfnOutput;
  readonly appUrl: cdk.CfnOutput;

  constructor(scope: Construct, id: string, props: GedeStageProps) {
    super(scope, id, props);
    const { config, hostedZoneId, appleSignIn } = props;
    const env: cdk.Environment = { account: config.account, region: config.region };
    const name = (stack: string): string => `GeDe-${capitalize(config.envName)}-${stack}`;

    // Aspects (and therefore Tags.of(app)) stop at Stage boundaries; tag the stage itself.
    for (const [key, value] of Object.entries(appTags(config))) {
      cdk.Tags.of(this).add(key, value);
    }

    const network = new NetworkStack(this, 'Network', { env, stackName: name('Network') });

    const data = new DataStack(this, 'Data', {
      env,
      stackName: name('Data'),
      vpc: network.vpc,
    });

    const auth = new AuthStack(this, 'Auth', {
      env,
      stackName: name('Auth'),
      config,
      hostedZoneId,
      appleSignIn,
    });

    const edge = new EdgeStack(this, 'Edge', {
      env: { account: config.account, region: EDGE_REGION },
      stackName: name('Edge'),
      config,
      hostedZoneId,
    });

    const web = new WebStack(this, 'Web', {
      env,
      stackName: name('Web'),
      config,
      certificate: edge.certificate,
      webAcl: edge.webAcl,
      userPoolId: auth.userPool.userPoolId,
      userPoolClientId: auth.userPoolClient.userPoolClientId,
      appleSignIn,
    });

    const service = new ServiceStack(this, 'Service', {
      env,
      stackName: name('Service'),
      config,
      hostedZoneId,
      vpc: network.vpc,
      database: data.database,
      dbSecurityGroup: data.dbSecurityGroup,
      docsBucket: data.docsBucket,
      emailIdentity: auth.emailIdentity,
      userPoolId: auth.userPool.userPoolId,
      userPoolClientId: auth.userPoolClient.userPoolClientId,
      originVerifySecrets: web.originVerifySecrets,
    });

    new DnsStack(this, 'Dns', {
      env,
      stackName: name('Dns'),
      config,
      hostedZoneId,
      distribution: web.distribution,
      alb: service.alb,
    });

    new OpsStack(this, 'Ops', {
      env,
      stackName: name('Ops'),
      config,
      service: service.service,
      alb: service.alb,
      database: data.database,
      cluster: service.cluster,
      jobsTaskDefinition: service.jobsTaskDefinition,
      jobsLogGroup: service.jobsLogGroup,
      serviceSecurityGroup: service.serviceSecurityGroup,
    });

    this.apiUrl = service.apiUrl;
    this.appUrl = web.appUrl;
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
