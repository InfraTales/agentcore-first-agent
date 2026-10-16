import { BedrockAgentCoreClient, CreateEventCommand, ListEventsCommand } from '@aws-sdk/client-bedrock-agentcore';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConversationMemory } from '../../agent/src/memory';

const agentcore = mockClient(BedrockAgentCoreClient);
const memory = new ConversationMemory('mem-123', new BedrockAgentCoreClient({ region: 'us-east-1' }));
const turn = (role: 'USER' | 'ASSISTANT', text: string) => ({ conversational: { role, content: { text } } });

beforeEach(() => agentcore.reset());

describe('ConversationMemory', () => {
  it('loads events for one actor and session, oldest first', async () => {
    agentcore.on(ListEventsCommand).resolves({
      events: [
        { memoryId: 'mem-123', actorId: 'a', sessionId: 's', eventId: '2', eventTimestamp: new Date(2000), payload: [turn('USER', 'second q'), turn('ASSISTANT', 'second a')] },
        { memoryId: 'mem-123', actorId: 'a', sessionId: 's', eventId: '1', eventTimestamp: new Date(1000), payload: [turn('USER', 'first q'), turn('ASSISTANT', 'first a')] },
      ],
    });
    const messages = await memory.load('cus_alice0001', 'session-1', 20);
    expect(messages.map((m) => [m.role, m.content[0]])).toEqual([
      ['user', { text: 'first q' }],
      ['assistant', { text: 'first a' }],
      ['user', { text: 'second q' }],
      ['assistant', { text: 'second a' }],
    ]);
    expect(agentcore.commandCalls(ListEventsCommand)[0]?.args[0].input).toEqual({
      memoryId: 'mem-123',
      actorId: 'cus_alice0001',
      sessionId: 'session-1',
      includePayloads: true,
      maxResults: 20,
    });
  });

  it('drops a leading assistant turn that the history window cut in half', async () => {
    agentcore.on(ListEventsCommand).resolves({
      events: [{ memoryId: 'm', actorId: 'a', sessionId: 's', eventId: '1', eventTimestamp: new Date(1), payload: [turn('ASSISTANT', 'orphan'), turn('USER', 'q')] }],
    });
    expect((await memory.load('a', 's', 1)).map((m) => m.role)).toEqual(['user']);
  });

  it('returns no history for a new session', async () => {
    agentcore.on(ListEventsCommand).resolves({ events: [] });
    expect(await memory.load('a', 's', 20)).toEqual([]);
  });

  it('saves one event holding the user turn and the assistant turn', async () => {
    agentcore.on(CreateEventCommand).resolves({});
    const at = new Date('2026-10-16T12:00:00Z');
    await memory.save('cus_alice0001', 'session-1', 'Where is my order?', 'It shipped.', at);
    expect(agentcore.commandCalls(CreateEventCommand)[0]?.args[0].input).toEqual({
      memoryId: 'mem-123',
      actorId: 'cus_alice0001',
      sessionId: 'session-1',
      eventTimestamp: at,
      payload: [turn('USER', 'Where is my order?'), turn('ASSISTANT', 'It shipped.')],
    });
  });
});
