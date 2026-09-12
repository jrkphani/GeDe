import * as cdk from 'aws-cdk-lib';

import { type AppContext, HOSTED_ZONE_PLACEHOLDER, PROD, appTags } from './config.js';
import { PipelineStack } from './pipeline-stack.js';

/** Read and type-check the context keys declared in cdk.json (overridable with `-c key=value`). */
export function readContext(app: cdk.App): AppContext {
  const str = (key: string): string => {
    const value: unknown = app.node.tryGetContext(key);
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`cdk.json context "${key}" must be a non-empty string`);
    }
    return value;
  };
  const bool = (key: string): boolean => {
    const value: unknown = app.node.tryGetContext(key);
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true; // `-c key=true` arrives as a string
    if (value === 'false' || value === undefined) return false;
    throw new Error(`cdk.json context "${key}" must be a boolean`);
  };

  const context: AppContext = {
    codeConnectionArn: str('codeConnectionArn'),
    hostedZoneId: str('hostedZoneId'),
    appleSignIn: bool('appleSignIn'),
    githubRepo: str('githubRepo'),
    githubBranch: str('githubBranch'),
  };

  if (context.hostedZoneId === HOSTED_ZONE_PLACEHOLDER) {
    cdk.Annotations.of(app).addWarningV2(
      'gede:hosted-zone-placeholder',
      'hostedZoneId is still the placeholder; set it in infra/cdk.json after registering the domain.',
    );
  }
  return context;
}

/** Builds the whole app; shared by `cdk synth` and the unit tests. */
export function buildApp(app: cdk.App): PipelineStack {
  for (const [key, value] of Object.entries(appTags(PROD))) {
    cdk.Tags.of(app).add(key, value);
  }
  return new PipelineStack(app, 'GeDe-Pipeline', {
    env: { account: PROD.account, region: PROD.region },
    config: PROD,
    context: readContext(app),
  });
}
