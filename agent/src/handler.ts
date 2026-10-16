import { Agent, type ContentBlock, type Model } from '@strands-agents/sdk';
import { z } from 'zod';
import type { AgentSettings } from './config';
import type { ConversationMemory } from './memory';
import type { OrdersRepository } from './orders';
import { SYSTEM_PROMPT } from './prompt';
import { buildTools } from './tools';

/**
 * The request body your backend sends to InvokeAgentRuntime. The backend signs
 * the call with IAM, so it's the only caller, and it sets customerId from its
 * own sign-in session. The end user only controls `prompt`.
 */
export const invocationSchema = z
  .object({
    prompt: z.string().trim().min(1).max(4000),
    customerId: z.string().regex(/^cus_[A-Za-z0-9]{8,32}$/),
  })
  .strict();

export type Invocation = z.infer<typeof invocationSchema>;

export interface InvocationResult {
  reply: string;
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface Logger {
  info(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface Dependencies {
  createModel: () => Model;
  repo: OrdersRepository;
  memory: ConversationMemory;
  now: () => Date;
  settings: Pick<AgentSettings, 'maxTurns' | 'maxTotalTokens' | 'historyEvents'>;
}

/** What callers see when the agent fails. Details go to the log, never to the response. */
export const PUBLIC_ERROR = 'The agent could not complete this request.';
export const LIMIT_REPLY =
  "I couldn't finish that within this conversation's limits. Could you ask again in a shorter, more specific way?";

export async function handleInvocation(
  deps: Dependencies,
  request: Invocation,
  ctx: { sessionId: string; log: Logger },
): Promise<InvocationResult> {
  const { customerId, prompt } = request;
  try {
    const history = await deps.memory.load(customerId, ctx.sessionId, deps.settings.historyEvents);
    const agent = new Agent({
      model: deps.createModel(),
      systemPrompt: SYSTEM_PROMPT,
      tools: buildTools(deps.repo, customerId, deps.now, (err) => ctx.log.error({ err: describe(err) }, 'tool failed')),
      messages: history,
      printer: false,
    });

    const result = await agent.invoke(prompt, {
      limits: { turns: deps.settings.maxTurns, totalTokens: deps.settings.maxTotalTokens },
    });

    const limited = result.stopReason === 'limitTurns' || result.stopReason === 'limitTotalTokens';
    const text = textOf(result.lastMessage.content);
    const reply = limited || text === '' ? LIMIT_REPLY : text;
    const usage = result.metrics?.latestAgentInvocation?.usage;

    try {
      await deps.memory.save(customerId, ctx.sessionId, prompt, reply, deps.now());
    } catch (err) {
      // The customer still gets an answer; the next turn just has less context.
      ctx.log.error({ err: describe(err) }, 'memory save failed');
    }

    ctx.log.info({ stopReason: result.stopReason, usage }, 'invocation complete');
    return {
      reply,
      stopReason: result.stopReason,
      usage: { inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0 },
    };
  } catch (err) {
    ctx.log.error({ err: describe(err) }, 'invocation failed');
    // The runtime SDK sends only the message to the caller; the cause stays server-side.
    throw new Error(PUBLIC_ERROR, { cause: err });
  }
}

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .map((b) => (b.type === 'textBlock' ? b.text : ''))
    .join('')
    .trim();
}

function describe(err: unknown): { name: string; message: string } {
  return err instanceof Error ? { name: err.name, message: err.message } : { name: 'Unknown', message: String(err) };
}
