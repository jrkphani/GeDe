import * as cdk from 'aws-cdk-lib';
import {
  aws_codebuild as codebuild,
  aws_codepipeline as codepipeline,
  pipelines,
} from 'aws-cdk-lib';
import { type Construct } from 'constructs';

import { type AppContext, type EnvConfig } from './config.js';
import { GedeStage } from './gede-stage.js';

export interface PipelineStackProps extends cdk.StackProps {
  readonly config: EnvConfig;
  readonly context: AppContext;
}

/** ARM Graviton CodeBuild: matches the Fargate ARM64 image, so no emulation during `docker build`. */
const ARM_SMALL: codebuild.BuildEnvironment = {
  buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0,
  computeType: codebuild.ComputeType.SMALL,
};

/**
 * `main` is production. Push → Synth (verify + build web + cdk synth) → self-mutate →
 * publish assets (arm64 image, web bundle) → Prod stage → smoke test.
 */
export class PipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);
    const { config, context } = props;

    const source = pipelines.CodePipelineSource.connection(
      context.githubRepo,
      context.githubBranch,
      {
        connectionArn: context.codeConnectionArn,
        triggerOnPush: true,
      },
    );

    const synth = new pipelines.CodeBuildStep('Synth', {
      input: source,
      installCommands: ['npm ci'],
      commands: [
        'npm run verify',
        'npm run build --workspace apps/web',
        'npm run synth --workspace infra',
      ],
      primaryOutputDirectory: 'infra/cdk.out',
      buildEnvironment: ARM_SMALL,
      // LOCAL_CUSTOM_CACHE takes its paths from the buildspec; `Cache.local()` only flags the mode.
      cache: codebuild.Cache.local(codebuild.LocalCacheMode.CUSTOM),
      partialBuildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: { install: { 'runtime-versions': { nodejs: 22 } } },
        cache: { paths: ['node_modules/**/*'] },
      }),
    });

    const pipeline = new pipelines.CodePipeline(this, 'Pipeline', {
      pipelineName: 'GeDe',
      pipelineType: codepipeline.PipelineType.V2,
      synth,
      selfMutation: true,
      crossAccountKeys: false,
      publishAssetsInParallel: false,
      dockerEnabledForSelfMutation: false,
      codeBuildDefaults: { buildEnvironment: ARM_SMALL },
      assetPublishingCodeBuildDefaults: {
        buildEnvironment: { ...ARM_SMALL, privileged: true },
      },
    });

    const prod = new GedeStage(this, 'Prod', {
      env: { account: config.account, region: config.region },
      config,
      hostedZoneId: context.hostedZoneId,
      appleSignIn: context.appleSignIn,
    });

    const smoke = new pipelines.ShellStep('Smoke', {
      envFromCfnOutputs: { API_URL: prod.apiUrl, APP_URL: prod.appUrl },
      commands: [
        'curl -fsS --retry 12 --retry-delay 10 --retry-all-errors "$API_URL/healthz"',
        'curl -fsS --retry 6 --retry-delay 10 --retry-all-errors "$APP_URL/" | grep -q \'id="root"\'',
      ],
    });

    pipeline.addStage(prod, {
      // Enable once a Staging stage precedes Prod (see infra/CLAUDE.md):
      // pre: [new pipelines.ManualApprovalStep('PromoteToProd')],
      post: [smoke],
    });
  }
}
