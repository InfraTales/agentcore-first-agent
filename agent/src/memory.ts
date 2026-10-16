import { BedrockAgentCoreClient, CreateEventCommand, ListEventsCommand } from '@aws-sdk/client-bedrock-agentcore';
import type { MessageData } from '@strands-agents/sdk';

/**
 * Short-term conversation memory in AgentCore Memory. The Runtime keeps a
 * session's microVM alive only until the idle timeout, so anything kept in
 * process memory is gone after that. Each turn is saved as an event under
 * (actorId = customer, sessionId = runtime session).
 */
export class ConversationMemory {
  constructor(
    private readonly memoryId: string,
    private readonly client: BedrockAgentCoreClient = new BedrockAgentCoreClient({}),
  ) {}

  async load(actorId: string, sessionId: string, maxEvents: number): Promise<MessageData[]> {
    const out = await this.client.send(
      new ListEventsCommand({ memoryId: this.memoryId, actorId, sessionId, includePayloads: true, maxResults: maxEvents }),
    );
    const events = [...(out.events ?? [])].sort(
      (a, b) => (a.eventTimestamp?.getTime() ?? 0) - (b.eventTimestamp?.getTime() ?? 0),
    );
    const messages: MessageData[] = [];
    for (const event of events) {
      for (const item of event.payload ?? []) {
        const turn = item.conversational;
        const text = turn?.content?.text;
        if (!text) continue;
        if (turn.role === 'USER') messages.push({ role: 'user', content: [{ text }] });
        else if (turn.role === 'ASSISTANT') messages.push({ role: 'assistant', content: [{ text }] });
      }
    }
    return dropLeadingAssistant(messages);
  }

  async save(actorId: string, sessionId: string, userText: string, assistantText: string, at: Date): Promise<void> {
    await this.client.send(
      new CreateEventCommand({
        memoryId: this.memoryId,
        actorId,
        sessionId,
        eventTimestamp: at,
        payload: [
          { conversational: { role: 'USER', content: { text: userText } } },
          { conversational: { role: 'ASSISTANT', content: { text: assistantText } } },
        ],
      }),
    );
  }
}

/** Models reject a conversation that starts with an assistant turn. A history window can cut one off. */
function dropLeadingAssistant(messages: MessageData[]): MessageData[] {
  let start = 0;
  while (start < messages.length && messages[start]?.role !== 'user') start += 1;
  return messages.slice(start);
}
