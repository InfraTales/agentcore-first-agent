#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { OrderAgentStack } from '../lib/order-agent-stack';

const app = new cdk.App();

// Optional: cdk deploy -c modelId=<inference profile ID>
const modelId: unknown = app.node.tryGetContext('modelId');
if (modelId !== undefined && typeof modelId !== 'string') {
  throw new Error(`modelId must be a string, got ${JSON.stringify(modelId)}`);
}

new OrderAgentStack(app, 'OrderSupportAgent', {
  modelId,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
});

// Fail synth on any AWS Solutions finding that isn't acknowledged with a reason.
cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
