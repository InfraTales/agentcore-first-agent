# An order support agent on Amazon Bedrock AgentCore

This repo holds a small AI agent that answers customers' questions about their own orders and starts returns. It runs on Amazon Bedrock AgentCore Runtime, keeps the conversation in AgentCore Memory, and reads orders from Amazon DynamoDB. We wrote it in TypeScript with Strands Agents, and the AWS Cloud Development Kit (CDK) deploys it.

The agent itself is short. Most of the code deals with production questions: who may call it, what the model can reach, what a conversation costs. The tests run the deployable file the way AgentCore runs it.

## What it does

A customer types a question in your app. Your backend, signed in as an IAM role, sends it to the agent:

```json
{ "prompt": "Can I return the shoes from last month?", "customerId": "cus_alice0001" }
```

The agent has three tools:

| Tool | What it does |
|---|---|
| `list_recent_orders` | Lists the customer's latest orders |
| `lookup_order` | Gets one order's status by order ID |
| `request_return` | Starts a return if the order was delivered in the last 30 days |

It answers in JSON with `reply`, `stopReason` and token `usage`.

## How it fits together

1. Your backend calls `InvokeAgentRuntime` with a session ID. AgentCore checks the IAM signature and starts a microVM for that session, or reuses the one that's running.
2. AgentCore starts `index.js` with the `NODE_22` managed runtime. The server (from the `bedrock-agentcore` SDK) listens on port 8080 and serves `POST /invocations` and `GET /ping`.
3. The agent loads earlier turns for this customer and session from AgentCore Memory.
4. Strands runs the agent loop. The model is Amazon Nova 2 Lite on Amazon Bedrock, through the `us.` cross-Region inference profile.
5. Tools read and write the orders table. They take the customer ID from the request, not from the model.
6. The agent saves the new turn to AgentCore Memory and replies.

## The security model in four lines

- Only IAM principals with the `InvokeAgentPolicy` managed policy can call the agent. Attach it to your backend's role and nothing else.
- Your backend sets the customer ID, and the tools capture it. The model chooses order IDs, but every lookup runs inside the signed-in customer's partition, so a prompt injection can't reach another customer's orders.
- The runtime role can call one model through one inference profile, use three DynamoDB actions on one table, and read and write events in one memory.
- Errors reach the caller as a generic message. AWS error text and table names stay in the logs.

[docs/security.md](docs/security.md) explains each one and what we chose not to add.

## Deploy

You need Node.js 22.12 or later (CI uses 24), AWS credentials, and a CDK-bootstrapped account in a Region that has AgentCore Runtime and Memory. The stack deploys to us-east-1 unless `CDK_DEFAULT_REGION` says otherwise.

```bash
npm ci
npm run check     # type check, lint, bundle, tests, synth with cdk-nag
npm run deploy
npm run seed      # sample orders for two customers
npm run smoke     # three real calls to the deployed agent
```

Bedrock enables Amazon Nova models for an account by default. To change the model, pass `-c modelId=<inference profile ID>` and add the profile to `infra/lib/models.ts`, so the stack can grant it.

## Tests

| Command | What runs | Needs |
|---|---|---|
| `npm test` | Unit, flow, CDK template, cdk-nag and bundle tests | DynamoDB Local |
| `npm run test:contract` | The deployable `index.js` as its own process, over HTTP | DynamoDB Local |
| `npm run smoke` | Calls to your deployed agent | A deploy |

Start DynamoDB Local first:

```bash
docker run -d --name ddb-local -p 8019:8000 amazon/dynamodb-local:3.3.2
export AWS_ENDPOINT_URL_DYNAMODB=http://localhost:8019
```

The flow tests run the real Strands agent loop with a scripted model in place of Bedrock. The contract tests start `build/agent/index.js` and call `/ping` and `/invocations` the way AgentCore does. A fake Bedrock (HTTP/2, real Converse format) and a fake AgentCore Memory stand in for AWS, reached through the standard `AWS_ENDPOINT_URL_<SERVICE>` variables, so the code under test has no test-only branches. CI runs the contract tests on Node.js 22 on Linux arm64, which matches the managed runtime.

We broke each safeguard on purpose once and checked that a test failed. The list of safeguards and their tests is in [CONTRIBUTING.md](CONTRIBUTING.md).

## Cost

AgentCore and Bedrock have no free monthly allowance. In the example in [docs/cost.md](docs/cost.md), 10,000 conversations of three questions each cost about $77 a month in us-east-1. The model is about $74 of that. Runtime compute and memory together are about $2.25.

## More docs

- [docs/security.md](docs/security.md): who can call the agent, what the agent can reach, and why
- [docs/cost.md](docs/cost.md): the pricing model with a worked month
- [docs/runbook.md](docs/runbook.md): logs, common errors and how to clean up

## License

The code is MIT-0 licensed, as the [LICENSE](LICENSE) file states.

---

Created by Rahul Ladumor / InfraTales
