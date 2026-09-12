import * as cdk from 'aws-cdk-lib';
import {
  aws_codebuild as codebuild,
  aws_codepipeline as codepipeline,
  aws_logs as logs,
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
 * Synth only: `eslint . --quiet` type-checks the whole monorepo in one process and ran out
 * of V8's default heap on SMALL (3 GB host → ~1.6 GB heap) once Wave 2 landed (execution
 * 5eb15a75, exit 134). MEDIUM is 4 vCPU / 7 GB; `NODE_OPTIONS` raises the heap to match.
 * Self-mutate, asset publishing and smoke stay on SMALL.
 */
const ARM_MEDIUM: codebuild.BuildEnvironment = {
  buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0,
  computeType: codebuild.ComputeType.MEDIUM,
};
const SYNTH_NODE_OPTIONS = '--max-old-space-size=4096';

/**
 * Shared libraries Chromium needs on Amazon Linux 2023, one dnf package per Debian
 * package in Playwright's own `ubuntu24.04-arm64` chromium list (`playwright-core`
 * `deps` table). Playwright's `install-deps` only knows `apt-get`, so on AL2023 this
 * is the install step. `dejavu-sans-fonts` gives the headless shell a font to shape
 * text with. Every name was checked against the AL2023 aarch64 core repo metadata.
 */
export const CHROMIUM_DNF_PACKAGES: readonly string[] = [
  'alsa-lib', // libasound2
  'at-spi2-atk', // libatk-bridge2.0-0
  'atk', // libatk1.0-0
  'at-spi2-core', // libatspi2.0-0
  'cairo', // libcairo2
  'cups-libs', // libcups2
  'dbus-libs', // libdbus-1-3
  'libdrm', // libdrm2
  'mesa-libgbm', // libgbm1
  'glib2', // libglib2.0-0
  'nspr', // libnspr4
  'nss', // libnss3
  'pango', // libpango-1.0-0
  'libX11', // libx11-6
  'libxcb', // libxcb1
  'libXcomposite', // libxcomposite1
  'libXdamage', // libxdamage1
  'libXext', // libxext6
  'libXfixes', // libxfixes3
  'libxkbcommon', // libxkbcommon0
  'libXrandr', // libxrandr2
  'dejavu-sans-fonts',
];

/**
 * `main` is production. Push → Synth (verify + db:parity + e2e + build web + cdk synth) →
 * self-mutate → publish assets (arm64 image, web bundle) → Prod stage → smoke test.
 *
 * The Playwright journeys (`npm run e2e`) run inside Synth, after `npm run verify` and the
 * migrations parity check and before the web build: a red journey stops the pipeline before
 * anything is published. See infra/CLAUDE.md, "Playwright on CodeBuild".
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
      // Playwright reads CI to pick workers, retries and reporters (apps/web/playwright.config.ts);
      // `db:parity` reads it to fail rather than skip when Docker is missing.
      env: { CI: 'true', NODE_OPTIONS: SYNTH_NODE_OPTIONS },
      installCommands: [
        `dnf install -y -q ${CHROMIUM_DNF_PACKAGES.join(' ')}`,
        'npm ci',
        // Chrome Headless Shell only (linux-arm64 build from cdn.playwright.dev, ~95 MB);
        // it lands in ~/.cache/ms-playwright, which the local cache keeps between builds.
        'npx playwright install --only-shell chromium',
      ],
      commands: [
        'npm run verify',
        // Production dependencies with a high or critical advisory fail the build (#41).
        'npm run audit',
        // Applies every migration to a throwaway postgres:17 (Docker, hence
        // `dockerEnabledForSynth`) before anything reaches production. With
        // CI=true the script fails rather than skips when Docker is missing.
        'npm run db:parity -w packages/db',
        'npm run e2e',
        'npm run build --workspace apps/web',
        'npm run synth --workspace infra',
      ],
      primaryOutputDirectory: 'infra/cdk.out',
      buildEnvironment: ARM_MEDIUM,
      // LOCAL_CUSTOM_CACHE takes its paths from the buildspec; `Cache.local()` only flags the mode.
      cache: codebuild.Cache.local(codebuild.LocalCacheMode.CUSTOM),
      partialBuildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: { install: { 'runtime-versions': { nodejs: 22 } } },
        cache: { paths: ['node_modules/**/*', '/root/.cache/ms-playwright/**/*'] },
      }),
    });

    // One log group for every CodeBuild project in the pipeline (Synth, SelfMutate, Assets,
    // Smoke); without it CodeBuild creates never-expiring groups per project (issue #42).
    const buildLogs = new logs.LogGroup(this, 'BuildLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const pipeline = new pipelines.CodePipeline(this, 'Pipeline', {
      pipelineName: 'GeDe',
      pipelineType: codepipeline.PipelineType.V2,
      synth,
      selfMutation: true,
      crossAccountKeys: false,
      publishAssetsInParallel: false,
      // The Synth project runs privileged so `db:parity` can start Postgres in Docker.
      dockerEnabledForSynth: true,
      dockerEnabledForSelfMutation: false,
      codeBuildDefaults: {
        buildEnvironment: ARM_SMALL,
        logging: { cloudWatch: { logGroup: buildLogs } },
      },
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

    // The API is probed through CloudFront (`/api/health`), which adds the origin-verify
    // header; the bare origin hostname must answer 403 without it (issue #33).
    const smoke = new pipelines.ShellStep('Smoke', {
      envFromCfnOutputs: { API_URL: prod.apiUrl, APP_URL: prod.appUrl },
      commands: [
        'curl -fsS --retry 12 --retry-delay 10 --retry-all-errors "$APP_URL/api/health"',
        'curl -fsS --retry 6 --retry-delay 10 --retry-all-errors "$APP_URL/" | grep -q \'id="root"\'',
        'test "$(curl -sS -o /dev/null -w \'%{http_code}\' "$API_URL/api/health")" = 403',
      ],
    });

    pipeline.addStage(prod, {
      // Deliberately absent: with a single Prod environment there is nothing to promote from,
      // and a gate that a merger approves themselves adds latency, not review. Enable it once
      // a Staging stage precedes Prod (see infra/CLAUDE.md and ADR-021):
      // pre: [new pipelines.ManualApprovalStep('PromoteToProd')],
      post: [smoke],
    });
  }
}
