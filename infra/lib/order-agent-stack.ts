import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3Assets from 'aws-cdk-lib/aws-s3-assets';
import type { Construct } from 'constructs';
import { assertRegionSupported, resolveModel } from './models';

export interface OrderAgentStackProps extends cdk.StackProps {
  /** Bedrock inference profile ID. Defaults to DEFAULT_MODEL_ID in models.ts. */
  modelId?: string;
}

/** Where `npm run bundle` writes the agent. */
export const BUNDLE_DIR = path.join(__dirname, '..', '..', 'build', 'agent');

export const RUNTIME_NAME = 'order_support_agent';
export const MEMORY_NAME = 'order_support_memory';
/** Days AgentCore Memory keeps raw conversation events. */
export const EVENT_EXPIRY_DAYS = 30;
/** End a session's microVM after 5 idle minutes. Memory bills until then; AgentCore Memory keeps the conversation. */
export const IDLE_TIMEOUT_SECONDS = 300;
/** Hard cap on one session's life: 8 hours. */
export const MAX_LIFETIME_SECONDS = 28800;

export class OrderAgentStack extends cdk.Stack {
  readonly runtime: agentcore.CfnRuntime;
  readonly memory: agentcore.CfnMemory;
  readonly table: dynamodb.TableV2;
  readonly runtimeRole: iam.Role;
  readonly invokePolicy: iam.ManagedPolicy;
  private readonly modelId: string | undefined;

  constructor(scope: Construct, id: string, props: OrderAgentStackProps = {}) {
    super(scope, id, props);
    this.modelId = props.modelId;
    const model = resolveModel(props.modelId);
    if (cdk.Token.isUnresolved(this.region)) {
      throw new Error('Set a Region for this stack (env.region, or AWS_REGION when you run cdk). The model profile only works from some Regions.');
    }
    assertRegionSupported(model, this.region);

    // Orders, keyed by customer. Every read and write names the customer in the key.
    this.table = new dynamodb.TableV2(this, 'Orders', {
      partitionKey: { name: 'customerId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'orderId', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Short-term memory only: raw turns per (customer, session), deleted after 30 days.
    // No long-term strategies, so nothing extracts or stores facts about customers.
    this.memory = new agentcore.CfnMemory(this, 'Memory', {
      name: MEMORY_NAME,
      description: 'Conversation turns for the order support agent',
      eventExpiryDuration: EVENT_EXPIRY_DAYS,
    });

    // The agent code: build/agent zipped by CDK and uploaded to the CDK assets bucket.
    // Direct code deployment, so AWS patches the Node.js runtime, not us.
    if (!fs.existsSync(path.join(BUNDLE_DIR, 'index.js'))) {
      throw new Error(`No agent bundle in ${BUNDLE_DIR}. Run "npm run bundle" first.`);
    }
    const code = new s3Assets.Asset(this, 'AgentCode', { path: BUNDLE_DIR });

    this.runtimeRole = this.createRuntimeRole(model);

    this.runtime = new agentcore.CfnRuntime(this, 'Runtime', {
      agentRuntimeName: RUNTIME_NAME,
      description: 'Order support agent (Strands Agents, TypeScript)',
      agentRuntimeArtifact: {
        codeConfiguration: {
          code: { s3: { bucket: code.s3BucketName, prefix: code.s3ObjectKey } },
          runtime: 'NODE_22',
          entryPoint: ['index.js'],
        },
      },
      roleArn: this.runtimeRole.roleArn,
      networkConfiguration: { networkMode: 'PUBLIC' },
      protocolConfiguration: 'HTTP',
      lifecycleConfiguration: {
        idleRuntimeSessionTimeout: IDLE_TIMEOUT_SECONDS,
        maxLifetime: MAX_LIFETIME_SECONDS,
      },
      environmentVariables: {
        AGENT_REGION: this.region,
        MODEL_ID: model.profileId,
        ORDERS_TABLE: this.table.tableName,
        MEMORY_ID: this.memory.attrMemoryId,
        MAX_TURNS: '6',
        MAX_TOTAL_TOKENS: '20000',
        HISTORY_EVENTS: '20',
        NODE_OPTIONS: '--enable-source-maps',
      },
    });
    // The role's policy must exist before the runtime starts a session.
    this.runtime.node.addDependency(this.runtimeRole);

    // Attach this to your backend's role. Nothing else should call the agent.
    this.invokePolicy = new iam.ManagedPolicy(this, 'InvokeAgentPolicy', {
      description: 'Lets a backend call the order support agent',
      statements: [
        new iam.PolicyStatement({
          actions: ['bedrock-agentcore:InvokeAgentRuntime'],
          // IAM checks the call against the runtime and the endpoint it lands on.
          // Endpoint ARNs are runtime/<id>/runtime-endpoint/<name>; DEFAULT is the one AgentCore creates.
          resources: [this.runtime.attrAgentRuntimeArn, `${this.runtime.attrAgentRuntimeArn}/runtime-endpoint/*`],
        }),
      ],
    });

    new cdk.CfnOutput(this, 'AgentRuntimeArn', { value: this.runtime.attrAgentRuntimeArn });
    new cdk.CfnOutput(this, 'MemoryId', { value: this.memory.attrMemoryId });
    new cdk.CfnOutput(this, 'OrdersTableName', { value: this.table.tableName });
    new cdk.CfnOutput(this, 'InvokePolicyArn', { value: this.invokePolicy.managedPolicyArn });

    this.acknowledgeFindings();
  }

  private createRuntimeRole(model: ReturnType<typeof resolveModel>): iam.Role {
    const runtimeArnPattern = `arn:${this.partition}:bedrock-agentcore:${this.region}:${this.account}:*`;
    const role = new iam.Role(this, 'RuntimeRole', {
      description: 'Execution role for the order support agent on AgentCore Runtime',
      // Confused-deputy guard: only AgentCore, acting for this account, can assume it.
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': runtimeArnPattern },
        },
      }),
    });

    const profileArn = `arn:${this.partition}:bedrock:${this.region}:${this.account}:inference-profile/${model.profileId}`;
    const logGroupArn = `arn:${this.partition}:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*`;
    const statements: iam.PolicyStatement[] = [
      // Runtime logs.
      new iam.PolicyStatement({
        sid: 'Logs',
        actions: ['logs:CreateLogGroup', 'logs:DescribeLogStreams', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [logGroupArn, `${logGroupArn}:log-stream:*`],
      }),
      new iam.PolicyStatement({ sid: 'DescribeLogGroups', actions: ['logs:DescribeLogGroups'], resources: [`arn:${this.partition}:logs:${this.region}:${this.account}:log-group:*`] }),
      // Traces and metrics for AgentCore Observability.
      new iam.PolicyStatement({
        sid: 'Traces',
        actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords', 'xray:GetSamplingRules', 'xray:GetSamplingTargets'],
        resources: ['*'],
      }),
      new iam.PolicyStatement({
        sid: 'Metrics',
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' } },
      }),
      // The model, only through one inference profile. The profile can route to
      // several Regions, so the foundation model ARN needs a Region wildcard; the
      // condition limits it to calls made through this profile.
      new iam.PolicyStatement({
        sid: 'InvokeProfile',
        actions: ['bedrock:InvokeModel'],
        resources: [profileArn],
      }),
      new iam.PolicyStatement({
        sid: 'InvokeModelViaProfile',
        actions: ['bedrock:InvokeModel'],
        resources: [`arn:${this.partition}:bedrock:*::foundation-model/${model.foundationModelId}`],
        conditions: { StringEquals: { 'bedrock:InferenceProfileArn': profileArn } },
      }),
      // Conversation memory: write and read events in this one memory.
      new iam.PolicyStatement({
        sid: 'Memory',
        actions: ['bedrock-agentcore:CreateEvent', 'bedrock-agentcore:ListEvents'],
        resources: [this.memory.attrMemoryArn],
      }),
      // Orders: the three calls the tools make, on this one table. No Scan, no DeleteItem.
      new iam.PolicyStatement({
        sid: 'Orders',
        actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:UpdateItem'],
        resources: [this.table.tableArn],
      }),
    ];

    new iam.Policy(this, 'RuntimePolicy', { roles: [role], statements });
    return role;
  }

  /** Every cdk-nag finding we accept, scoped to the runtime policy, each with its reason. */
  private acknowledgeFindings(): void {
    const policy = this.node.findChild('RuntimePolicy');
    // cdk-nag prints concrete values as they appear in the template and tokens as <AWS::...>.
    const region = cdk.Token.isUnresolved(this.region) ? '<AWS::Region>' : this.region;
    const account = cdk.Token.isUnresolved(this.account) ? '<AWS::AccountId>' : this.account;
    const partition = cdk.Token.isUnresolved(this.partition) ? '<AWS::Partition>' : this.partition;
    const logs = `arn:${partition}:logs:${region}:${account}:log-group`;
    const ack = (resource: string, reason: string) =>
      cdk.Validations.of(policy).acknowledge({ id: `AwsSolutions::AwsSolutions-IAM5[Resource::${resource}]`, reason });

    ack(
      `${logs}:/aws/bedrock-agentcore/runtimes/*`,
      'AgentCore names the runtime log group after the runtime ID, which exists only after create. Scoped to the AgentCore runtimes prefix, as in the AgentCore runtime permissions docs.',
    );
    ack(`${logs}:/aws/bedrock-agentcore/runtimes/*:log-stream:*`, 'Log streams inside the AgentCore runtime log groups; names are chosen by the service per session.');
    ack(`${logs}:*`, 'logs:DescribeLogGroups has no resource-level scoping beyond the account log-group ARN; listed in the AgentCore runtime permissions docs.');
    cdk.Validations.of(this.invokePolicy).acknowledge({
      id: 'AwsSolutions::AwsSolutions-IAM5[Resource::<Runtime.AgentRuntimeArn>/runtime-endpoint/*]',
      reason: 'Endpoints of this one runtime only. DEFAULT is created by AgentCore and later endpoints (for versions) keep working without a policy change.',
    });
    ack('*', 'X-Ray trace calls do not support resource-level permissions, and cloudwatch:PutMetricData is limited to the bedrock-agentcore namespace by a condition.');
    ack(
      `arn:${partition}:bedrock:*::foundation-model/${resolveModel(this.modelId).foundationModelId}`,
      'A cross-Region inference profile can route to any of its destination Regions. One model only, and the bedrock:InferenceProfileArn condition allows it only through this stack\'s profile.',
    );
  }
}
