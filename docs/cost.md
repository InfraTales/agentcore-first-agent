# Cost

AgentCore and Amazon Bedrock have no free monthly allowance, so this stack costs money from the first conversation. Prices below are us-east-1, checked on 2026-10-16 in the AWS Price List API and on the AgentCore pricing page.

## What you pay for

| Part | Price | When you pay |
|---|---|---|
| Runtime CPU (platform V1, the default) | $0.0895 per vCPU-hour | Per second while your code uses the CPU. Waiting on the model or DynamoDB doesn't count |
| Runtime memory (V1) | $0.00945 per GB-hour | Per second for the whole session, idle time included, with a 128 MB minimum |
| Nova 2 Lite, `us.` profile, input | $0.33 per million tokens | Every model call |
| Nova 2 Lite, `us.` profile, output | $2.75 per million tokens | Every model call |
| Memory, short-term, ingestion | $1.00 per GB | Each event is billed as at least 12 KB and at most 64 KB |
| Memory, short-term, retrieval | $0.20 per GB | Each `ListEvents` |
| Memory, short-term, storage | $0.10 per GB-month | Until events expire (30 days here) |
| DynamoDB on-demand reads | $0.125 per million read request units | Each order lookup |

Short-term memory moved to per-GB pricing on 6 October 2026. Before that it was $0.25 per 1,000 events.

## A worked month

Assume 10,000 conversations a month. Each one is a session with three questions. A question makes two model calls, one that picks a tool and one that writes the answer. Each model call sends about 2,500 tokens (system prompt, tool definitions and history) and gets back about 150.

For the Runtime, we measured the agent on a laptop with a fake model (`scripts/measure-cpu.ts`): about 7 ms of CPU per question, 0.15 s to start, and 110 to 220 MB of memory. We model 10 ms and 0.2 GB. AgentCore also bills system overhead, and a laptop can't show you that. Each session lasts 2 minutes of conversation plus the 5-minute idle timeout.

| Item | Math | Monthly |
|---|---|---|
| Model input | 30,000 questions × 2 calls × 2,500 tokens = 150M tokens × $0.33 | $49.50 |
| Model output | 30,000 × 2 × 150 = 9M tokens × $2.75 | $24.75 |
| Runtime memory | 10,000 sessions × 0.2 GB × 7 minutes = 233 GB-hours × $0.00945 | $2.21 |
| Runtime CPU | (30,000 × 0.01 s + 10,000 × 0.15 s) = 0.5 vCPU-hours × $0.0895 | $0.05 |
| Memory ingestion | 30,000 events × 12 KB = 0.36 GB × $1.00 | $0.36 |
| Memory retrieval and storage | At most 0.36 GB read and 0.36 GB-month stored | $0.11 |
| DynamoDB | 30,000 reads | $0.01 |
| **Total** | | **about $77** |

That comes to under one cent per conversation. The model accounts for 96% of it, and the Runtime for about 3%.

## Where the money goes, and what to change

Tokens: Every model call resends the system prompt, the tool definitions and the history. Cutting `HISTORY_EVENTS` or the prompt size moves the bill more than anything else. The per-invocation limits (6 turns, 20,000 tokens) cap the worst case for one question at about $0.02 of input.

Idle time: Runtime memory bills until the session ends. With the default 15-minute idle timeout, the memory line in this example grows from $2.21 to $5.36. This stack uses 5 minutes. The conversation is safe in AgentCore Memory, and a new microVM loads it on the next question.

Model choice: The `global.` profile for Nova 2 Lite costs $0.30 and $2.50 per million tokens, about 9% less, but can route requests to any supported Region worldwide. The `us.` profile keeps requests in US Regions.

Not counted above: CloudWatch Logs ingestion and storage for the runtime logs, the code zip in the CDK assets bucket at S3 Standard rates, and point-in-time recovery storage for the table ($0.20 per GB-month).
