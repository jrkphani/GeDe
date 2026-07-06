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

buildAppStacks(app, envName, domainName);
