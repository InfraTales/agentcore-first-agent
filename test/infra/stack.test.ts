import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { beforeAll, describe, expect, it } from 'vitest';
import { BUNDLE_DIR, OrderAgentStack } from '../../infra/lib/order-agent-stack';
import { testApp } from '../support/cdk-app';

const env = { account: '123456789012', region: 'us-east-1' };
let template: Template;

beforeAll(() => {
  template = Template.fromStack(new OrderAgentStack(testApp(), 'Test', { env }));
});

function policyStatements(): any[] {
  const policies = template.findResources('AWS::IAM::Policy');
  return Object.values<any>(policies).flatMap((p) => p.Properties.PolicyDocument.Statement);
}
const asArray = (v: unknown) => (Array.isArray(v) ? v : [v]);

describe('AgentCore Runtime', () => {
  it('runs the bundle with the NODE_22 managed runtime, public network, HTTP protocol', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      AgentRuntimeName: 'order_support_agent',
      AgentRuntimeArtifact: {
        CodeConfiguration: {
          Runtime: 'NODE_22',
          EntryPoint: ['index.js'],
          Code: { S3: { Bucket: Match.anyValue(), Prefix: Match.stringLikeRegexp('\\.zip$') } },
        },
      },
      NetworkConfiguration: { NetworkMode: 'PUBLIC' },
      ProtocolConfiguration: 'HTTP',
      LifecycleConfiguration: { IdleRuntimeSessionTimeout: 300, MaxLifetime: 28800 },
    });
  });

  it('passes every setting the agent requires at startup', () => {
    const runtime = Object.values<any>(template.findResources('AWS::BedrockAgentCore::Runtime'))[0];
    const vars = runtime.Properties.EnvironmentVariables;
    for (const name of ['AGENT_REGION', 'MODEL_ID', 'ORDERS_TABLE', 'MEMORY_ID']) expect(vars[name]).toBeDefined();
    expect(vars.MODEL_ID).toBe('us.amazon.nova-2-lite-v1:0');
    expect(vars.MAX_TURNS).toBe('6');
  });

  it('has no inbound JWT authorizer, so only IAM-signed callers get in', () => {
    const runtime = Object.values<any>(template.findResources('AWS::BedrockAgentCore::Runtime'))[0];
    expect(runtime.Properties.AuthorizerConfiguration).toBeUndefined();
  });
});

describe('AgentCore Memory', () => {
  it('keeps raw events 30 days and extracts nothing long-term', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::Memory', {
      Name: 'order_support_memory',
      EventExpiryDuration: 30,
      MemoryStrategies: Match.absent(),
    });
  });
});

describe('runtime role', () => {
  it('trusts only AgentCore, acting for this account', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [
          {
            Action: 'sts:AssumeRole',
            Principal: { Service: 'bedrock-agentcore.amazonaws.com' },
            Condition: {
              StringEquals: { 'aws:SourceAccount': '123456789012' },
              ArnLike: { 'aws:SourceArn': 'arn:aws:bedrock-agentcore:us-east-1:123456789012:*' },
            },
          },
        ],
      },
    });
  });

  it('never grants a wildcard action', () => {
    for (const s of policyStatements()) {
      for (const a of asArray(s.Action)) expect(a).not.toMatch(/\*/);
    }
  });

  it('can call the model only through Converse-style InvokeModel, via one profile', () => {
    const actions = policyStatements().flatMap((s) => asArray(s.Action));
    expect(actions).not.toContain('bedrock:InvokeModelWithResponseStream');
    const viaProfile = policyStatements().find((s) => s.Sid === 'InvokeModelViaProfile');
    expect(viaProfile.Condition.StringEquals['bedrock:InferenceProfileArn']).toBe(
      'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.amazon.nova-2-lite-v1:0',
    );
    expect(viaProfile.Resource).toBe('arn:aws:bedrock:*::foundation-model/amazon.nova-2-lite-v1:0');
  });

  it('touches the orders table with three actions only', () => {
    const orders = policyStatements().find((s) => s.Sid === 'Orders');
    expect(asArray(orders.Action).sort()).toEqual(['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:UpdateItem']);
  });

  it('reads and writes events in its own memory and nothing else in AgentCore', () => {
    const agentcoreActions = policyStatements()
      .flatMap((s) => asArray(s.Action))
      .filter((a: string) => a.startsWith('bedrock-agentcore:'));
    expect(agentcoreActions.sort()).toEqual(['bedrock-agentcore:CreateEvent', 'bedrock-agentcore:ListEvents']);
  });
});

it('gives callers InvokeAgentRuntime on this runtime and its endpoints only', () => {
  template.hasResourceProperties('AWS::IAM::ManagedPolicy', {
    PolicyDocument: {
      Statement: [
        {
          Action: 'bedrock-agentcore:InvokeAgentRuntime',
          Resource: [{ 'Fn::GetAtt': ['Runtime', 'AgentRuntimeArn'] }, { 'Fn::Join': ['', [{ 'Fn::GetAtt': ['Runtime', 'AgentRuntimeArn'] }, '/endpoint/*']] }],
        },
      ],
    },
  });
});

it('keeps point-in-time recovery on for orders', () => {
  template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
    Replicas: [Match.objectLike({ PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } })],
  });
});

it('refuses a model it has no IAM mapping for', () => {
  expect(() => new OrderAgentStack(testApp(), 'Bad', { env, modelId: 'some.unknown-model' })).toThrow('Unknown modelId');
});

it.each([
  ['a concrete account', env],
  ['an account token', { region: 'us-east-1' }],
])('cdk-nag AWS Solutions finds nothing unacknowledged with %s', (_label, stackEnv) => {
  const app = testApp({ outdir: fs.mkdtempSync(path.join(os.tmpdir(), 'cdk-nag-')) });
  new OrderAgentStack(app, 'Nag', { env: stackEnv });
  cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  const assembly = app.synth();
  const report = JSON.parse(fs.readFileSync(path.join(assembly.directory, 'validation-report.json'), 'utf8'));
  for (const plugin of report.pluginReports) expect(plugin.violations).toEqual([]);
});

it('stops synth with a clear message when the bundle is missing', () => {
  const backup = `${BUNDLE_DIR}.bak-${process.pid}`;
  fs.renameSync(BUNDLE_DIR, backup);
  try {
    expect(() => new OrderAgentStack(testApp(), 'NoBundle', { env })).toThrow('Run "npm run bundle" first');
  } finally {
    fs.renameSync(backup, BUNDLE_DIR);
  }
});
