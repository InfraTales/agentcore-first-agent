import { Model, type BaseModelConfig, type Message, type StreamOptions } from '@strands-agents/sdk';

/** One model turn: either text, or a request to call a tool. */
export type Turn = { text: string } | { toolUse: { name: string; input: unknown } };

export interface ModelCall {
  messages: Message[];
  systemPrompt: unknown;
  toolNames: string[];
}

/**
 * A stand-in for Bedrock that plays a fixed script, one turn per model call, and
 * records what the agent sent. It goes through the real Strands agent loop, so
 * tool calls, tool results and history work exactly as they do with a real model.
 */
export class ScriptedModel extends Model<BaseModelConfig> {
  readonly calls: ModelCall[] = [];
  private config: BaseModelConfig = { modelId: 'scripted' };
  private next = 0;

  constructor(private readonly script: Array<Turn | ((call: ModelCall) => Turn)>) {
    super();
  }

  updateConfig(modelConfig: BaseModelConfig): void {
    this.config = { ...this.config, ...modelConfig };
  }

  getConfig(): BaseModelConfig {
    return this.config;
  }

  async *stream(messages: Message[], options?: StreamOptions) {
    const call: ModelCall = {
      messages: [...messages],
      systemPrompt: options?.systemPrompt,
      toolNames: (options?.toolSpecs ?? []).map((t) => t.name),
    };
    this.calls.push(call);
    const step = this.script[this.next];
    this.next += 1;
    if (step === undefined) throw new Error(`ScriptedModel: no turn ${this.next} in the script`);
    const turn = typeof step === 'function' ? step(call) : step;

    yield { type: 'modelMessageStartEvent' as const, role: 'assistant' as const };
    if ('text' in turn) {
      yield { type: 'modelContentBlockStartEvent' as const };
      yield { type: 'modelContentBlockDeltaEvent' as const, delta: { type: 'textDelta' as const, text: turn.text } };
      yield { type: 'modelContentBlockStopEvent' as const };
      yield { type: 'modelMessageStopEvent' as const, stopReason: 'endTurn' as const };
    } else {
      const toolUseId = `tool-${this.next}`;
      yield {
        type: 'modelContentBlockStartEvent' as const,
        start: { type: 'toolUseStart' as const, name: turn.toolUse.name, toolUseId },
      };
      yield {
        type: 'modelContentBlockDeltaEvent' as const,
        delta: { type: 'toolUseInputDelta' as const, input: JSON.stringify(turn.toolUse.input) },
      };
      yield { type: 'modelContentBlockStopEvent' as const };
      yield { type: 'modelMessageStopEvent' as const, stopReason: 'toolUse' as const };
    }
    yield { type: 'modelMetadataEvent' as const, usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
  }
}

/** The tool results the agent sent back to the model in a call, parsed from JSON text. */
export function toolResults(call: ModelCall): Array<{ status: string; body: unknown }> {
  const results: Array<{ status: string; body: unknown }> = [];
  for (const message of call.messages) {
    for (const block of message.content) {
      if (block.type !== 'toolResultBlock') continue;
      const parts = block.content.map((c) => {
        if (c.type === 'jsonBlock') return c.json;
        if (c.type === 'textBlock') {
          try {
            return JSON.parse(c.text) as unknown;
          } catch {
            return c.text;
          }
        }
        return undefined;
      });
      results.push({ status: block.status, body: parts.length === 1 ? parts[0] : parts });
    }
  }
  return results;
}
