import * as cdk from 'aws-cdk-lib';

import { buildApp } from '../lib/app.js';

const app = new cdk.App();
buildApp(app);
app.synth();
