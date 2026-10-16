# Contributing

Thanks for helping. This repo shows a production setup for an agent on Amazon Bedrock AgentCore, so every change has to keep the tests honest about how the Runtime behaves.

## Setup

You need Node.js 22.12 or later and Docker for DynamoDB Local.

```bash
npm ci
docker run -d --name ddb-local -p 8019:8000 amazon/dynamodb-local:3.3.2
export AWS_ENDPOINT_URL_DYNAMODB=http://localhost:8019
npm run check           # type check, lint, bundle, tests, synth with cdk-nag
npm run test:contract   # the deployable bundle over HTTP
```

To run the contract tests on Node.js 22 while your shell uses another version, point `AGENT_NODE` at a Node.js 22 binary.

## Layout

| Path | What's there |
|---|---|
| `agent/src/server.ts` | Entry point. Wires real clients and starts the AgentCore server |
| `agent/src/handler.ts` | Payload schema, the agent loop with limits, error handling |
| `agent/src/tools.ts` | The three tools, bound to one customer |
| `agent/src/orders.ts` | DynamoDB access, including the conditional return write |
| `agent/src/memory.ts` | Short-term memory in AgentCore Memory |
| `infra/lib/order-agent-stack.ts` | The CDK stack: Runtime, Memory, table, IAM |
| `test/unit`, `test/flow`, `test/infra` | Tests that run with `npm test` |
| `test/contract` | The bundle as a process, with fake Bedrock and fake Memory |
| `scripts/` | Bundling, seed data, the smoke test and the CPU measurement |

## What a change needs

- **A test that fails without it.** For a bug, write the failing test first.
- **No customer ID in a tool's input.** Tools get it from the request through `buildTools`.
- **No AWS error text in a response or a tool result.** Log it instead.
- **A written reason for any cdk-nag acknowledgement**, scoped to the construct it's about.
- **Docs updated** when behaviour changes.

## Safeguards and the tests that guard them

Each line was broken on purpose and the named test failed:

| Safeguard | Test that caught the break |
|---|---|
| Tools ignore a customer ID from the model | `ignores a customerId the model tries to pass to a tool` |
| A return can be requested once | `lets exactly one of ten concurrent requests win` |
| The 30-day return window | `refuses after the 30-day window` |
| Generic errors for callers | `hides internal error details from the caller and logs them` |
| No AWS error text in tool results | `keeps AWS error text out of the model's context when a tool fails` |
| Turn and token limits | `stops a looping model at the turn limit and says so` |
| Strict payload schema | `rejects unknown fields, so a caller cannot smuggle in history or tools` |
| Model access only through the profile | `can call the model only through Converse-style InvokeModel, via one profile` |
| Bundle starts as CommonJS | `loads and fails fast on a missing setting instead of serving broken requests` |
| History reaches the model | `puts earlier turns from memory in front of the new prompt` |
| Only the public order view reaches the model | `looks up the order with a tool, answers, and saves the turn to memory` |

## Pull requests

Branch from `main`, keep each pull request to one change, and explain why in the description. CI must pass before merge.

Found a security problem? Don't open a public issue. [SECURITY.md](SECURITY.md) says where to send it.

---

Created by Rahul Ladumor / InfraTales
