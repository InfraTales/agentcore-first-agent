import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { BedrockModel } from '@strands-agents/sdk';
import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime';
import { loadSettings } from './config';
import { handleInvocation, invocationSchema, type Dependencies } from './handler';
import { ConversationMemory } from './memory';
import { OrdersRepository } from './orders';

// Fails here, at startup, if the stack forgot a setting.
const settings = loadSettings();

// SDK clients read AWS_ENDPOINT_URL_<SERVICE> like any AWS SDK, which is how the
// contract tests point this exact bundle at local fakes. No test-only code paths.
const deps: Dependencies = {
  createModel: () =>
    new BedrockModel({
      region: settings.region,
      modelId: settings.modelId,
      maxTokens: 1024,
      temperature: 0.2,
      // One JSON response per call (Converse). The agent replies once, so token
      // streaming would add nothing here.
      stream: false,
    }),
  repo: new OrdersRepository(settings.ordersTable, new DynamoDBClient({ region: settings.region })),
  memory: new ConversationMemory(settings.memoryId, new BedrockAgentCoreClient({ region: settings.region })),
  now: () => new Date(),
  settings,
};

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    requestSchema: invocationSchema,
    process: (request, context) => handleInvocation(deps, request, { sessionId: context.sessionId, log: context.log }),
  },
});

// The Runtime contract: HTTP on 0.0.0.0:8080 with POST /invocations and GET /ping.
app.run();
