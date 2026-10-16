# Runbook

## Where the logs are

AgentCore writes runtime logs to CloudWatch Logs under `/aws/bedrock-agentcore/runtimes/<runtime-id>-DEFAULT`. Each invocation logs `invocation complete` with the stop reason and token usage, or `invocation failed` with the error name and message.

```bash
aws logs tail /aws/bedrock-agentcore/runtimes/<runtime-id>-DEFAULT --follow
```

For traces and the generative AI dashboards, turn on CloudWatch Transaction Search once per account. Spans can take about ten minutes to appear.

## Common errors

| What you see | Likely cause | What to do |
|---|---|---|
| `AccessDeniedException` from `InvokeAgentRuntime` | The caller lacks the invoke policy | Attach `InvokeAgentPolicy` (stack output `InvokePolicyArn`) to the caller's role |
| HTTP 424 `RuntimeClientError` | The agent returned a 4xx or 5xx | Read the runtime logs. A 400 means the payload failed the schema |
| `{"error":"The agent could not complete this request."}` | The handler caught an error | The log line `invocation failed` has the real error |
| `invocation failed` with `AccessDeniedException` on Bedrock | The model isn't enabled, or the profile isn't in `infra/lib/models.ts` | Check model access in the Bedrock console, then the profile mapping |
| Replies say the agent couldn't finish within limits | The turn or token limit stopped the loop | Check `stopReason` in the log. Raise `MAX_TURNS` only if real conversations need it |
| `409 RetryableConflictException` | A transient conflict | Retry with backoff |

## Changing settings

Budgets and history size are runtime environment variables in `infra/lib/order-agent-stack.ts`: `MAX_TURNS`, `MAX_TOTAL_TOKENS` and `HISTORY_EVENTS`. Change them there and run `npm run deploy`.

## Clean up

```bash
npm run destroy
```

This deletes the runtime, the memory (with its events), the orders table and the IAM role and policies. The code zip stays in the CDK assets bucket until you empty it.
