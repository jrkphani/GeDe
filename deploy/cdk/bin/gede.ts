#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { buildAppStacks, ENVS, type EnvName } from '../lib/build-app';

const app = new cdk.App();

const envName = (app.node.tryGetContext('env') as EnvName | undefined) ?? 'test';
if (!ENVS[envName]) {
  throw new Error(`Unknown env context "${envName}". Known envs: ${Object.keys(ENVS).join(', ')}`);
}

// --- DNS seam context --------------------------------------------------------
// No `domainName` context => the DNS stack is inert (no zone/cert) and the
// Hosting stack serves the CloudFront default domain only. Supplying
// `-c domainName=app.example.com` flips both stacks to the real-domain path
// (see docs/DEPLOYMENT.md §7 and deploy/cdk/README.md "domain-flip").
const domainName = app.node.tryGetContext('domainName') as string | undefined;

// --- Debug/db inspection API seam (issue 049) --------------------------------
// `-c debugApi=true` enables the read-only db-inspection Lambda + its
// `/debug/db/*` ALB route + CloudFront behavior. Gated on `envName === 'test'`
// HERE, not just left to whatever the context flag says — so a future `prod`
// env can never accidentally expose this by inheriting a stray `-c` flag
// from a `test` deploy. Prod must not get these resources (issue 049 Scope).
const debugApiContext = app.node.tryGetContext('debugApi') as string | boolean | undefined;
const debugApi = envName === 'test' && (debugApiContext === true || debugApiContext === 'true');

buildAppStacks(app, envName, domainName, undefined, debugApi);
