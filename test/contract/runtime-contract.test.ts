/**
 * Contract tests for the AgentCore Runtime HTTP interface. They start the real
 * deployable file, build/agent/index.js, as its own Node.js process (Node 22 in CI,
 * like the NODE_22 managed runtime) and talk to it over HTTP the way AgentCore does:
 * GET /ping and POST /invocations on port 8080 with a session ID header.
 *
 * Bedrock and AgentCore Memory are local fakes reached through the standard
 * AWS_ENDPOINT_URL_<SERVICE> variables. Orders live in DynamoDB Local.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PUBLIC_ERROR } from '../../agent/src/handler';
import { BUNDLE_DIR } from '../../infra/lib/order-agent-stack';
import { ALICE, BOB, DYNAMODB_ENDPOINT, FIXTURE_ORDERS, createOrdersTable, dropTable, localClient, putOrders } from '../support/dynamodb-local';
import { FakeBedrock, FakeMemory } from './fakes';

const AGENT = 'http://127.0.0.1:8080';
const SESSION = 'contract-test-session-0000000000000001'; // AgentCore requires 33+ characters
const NODE = process.env.AGENT_NODE ?? process.execPath;

const bedrock = new FakeBedrock();
const memory = new FakeMemory();
const ddb = localClient();
let table: string;
let agent: ChildProcess;
let output = '';

async function waitForPing(deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (agent.exitCode !== null) throw new Error(`agent exited with ${agent.exitCode}:\n${output}`);
    try {
      if ((await fetch(`${AGENT}/ping`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`agent did not answer /ping within ${deadlineMs} ms:\n${output}`);
}

function invoke(body: unknown, headers: Record<string, string> = { 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': SESSION }) {
  return fetch(`${AGENT}/invocations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
}

beforeAll(async () => {
  await Promise.all([bedrock.start(), memory.start()]);
  table = await createOrdersTable(ddb);
  await putOrders(ddb, table, FIXTURE_ORDERS);
  agent = spawn(NODE, [path.join(BUNDLE_DIR, 'index.js')], {
    env: {
      PATH: process.env.PATH,
      AGENT_REGION: 'us-east-1',
      MODEL_ID: 'us.amazon.nova-2-lite-v1:0',
      ORDERS_TABLE: table,
      MEMORY_ID: 'mem-contract',
      // DynamoDB Local keeps a separate set of tables per access key, so use the test's key.
      AWS_ACCESS_KEY_ID: 'local',
      AWS_SECRET_ACCESS_KEY: 'local',
      AWS_ENDPOINT_URL_BEDROCK_RUNTIME: bedrock.url,
      AWS_ENDPOINT_URL_BEDROCK_AGENTCORE: memory.url,
      AWS_ENDPOINT_URL_DYNAMODB: DYNAMODB_ENDPOINT,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  agent.stdout?.on('data', (d: Buffer) => (output += d.toString()));
  agent.stderr?.on('data', (d: Buffer) => (output += d.toString()));
  await waitForPing(20_000);
});

afterAll(async () => {
  agent?.kill('SIGTERM');
  await Promise.all([bedrock.stop(), memory.stop()]);
  await dropTable(ddb, table);
});

beforeEach(() => {
  memory.requests.length = 0;
});

describe('GET /ping', () => {
  it('answers 200 with a Healthy status and a Unix timestamp in seconds', async () => {
    const res = await fetch(`${AGENT}/ping`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { status: string; time_of_last_update: number };
    expect(body.status).toBe('Healthy');
    expect(Number.isInteger(body.time_of_last_update)).toBe(true);
    expect(Math.abs(body.time_of_last_update - Date.now() / 1000)).toBeLessThan(120);
  });

  it("doesn't move time_of_last_update on every ping, so the idle timeout can fire", async () => {
    const first = (await (await fetch(`${AGENT}/ping`)).json()) as { time_of_last_update: number };
    await new Promise((r) => setTimeout(r, 1100));
    const second = (await (await fetch(`${AGENT}/ping`)).json()) as { time_of_last_update: number };
    expect(second.time_of_last_update).toBe(first.time_of_last_update);
  });
});

describe('POST /invocations', () => {
  it('runs a tool loop through Converse, answers in JSON, and saves the turn', async () => {
    bedrock.script(
      { toolUse: { name: 'lookup_order', input: { orderId: 'ORD-20260920-0001' } } },
      { text: 'Your shoes were delivered on 26 September.' },
    );
    const res = await invoke({ prompt: 'Where are my shoes? ORD-20260920-0001', customerId: ALICE });
    if (res.status !== 200) throw new Error(`status ${res.status}: ${await res.text()}\n${output}`);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toMatchObject({ reply: 'Your shoes were delivered on 26 September.', stopReason: 'endTurn' });

    // Two Converse calls to the configured inference profile, with our system prompt and tools.
    expect(bedrock.requests.map((r) => r.path)).toEqual([
      '/model/us.amazon.nova-2-lite-v1:0/converse',
      '/model/us.amazon.nova-2-lite-v1:0/converse',
    ]);
    const first = bedrock.requests[0]!.body;
    expect(JSON.stringify(first.system)).toContain('order support assistant');
    expect(first.toolConfig.tools.map((t: any) => t.toolSpec.name).sort()).toEqual(['list_recent_orders', 'lookup_order', 'request_return']);
    expect(first.inferenceConfig).toMatchObject({ maxTokens: 1024, temperature: 0.2 });

    // The second call carries the tool result, read from DynamoDB Local.
    expect(JSON.stringify(bedrock.requests[1]!.body.messages)).toContain('Trail running shoes');

    // Memory: one read for this customer and session, then one event with both turns.
    expect(memory.requests.map((r) => r.path)).toEqual([`/memories/mem-contract/actor/${ALICE}/sessions/${SESSION}`, '/memories/mem-contract/events']);
    expect(memory.events.at(-1)).toMatchObject({ actorId: ALICE, sessionId: SESSION });
  });

  it('sends the earlier turns of the same session to the model on the next call', async () => {
    bedrock.script({ text: 'You asked about your shoes.' });
    await invoke({ prompt: 'What did I just ask?', customerId: ALICE });
    const texts = JSON.stringify(bedrock.requests[0]!.body.messages);
    expect(texts).toContain('Where are my shoes?');
    expect(texts).toContain('What did I just ask?');
  });

  it("keeps one customer's history out of another customer's session", async () => {
    bedrock.script({ text: 'Hello Bob.' });
    await invoke({ prompt: 'Hi', customerId: BOB });
    expect(JSON.stringify(bedrock.requests[0]!.body.messages)).not.toContain('shoes');
  });

  it('rejects a request without a session ID', async () => {
    const res = await invoke({ prompt: 'hi', customerId: ALICE }, {});
    expect(res.status).toBe(400);
  });

  it('rejects a payload that fails the schema, before any model call', async () => {
    bedrock.script({ text: 'should not be used' });
    const res = await invoke({ prompt: [{ toolUse: { name: 'request_return', input: {} } }], customerId: ALICE });
    expect(res.status).toBe(400);
    expect(bedrock.requests).toHaveLength(0);
  });

  it('returns a 500 with a generic message when Bedrock fails, and keeps the details in the log', async () => {
    bedrock.script({ status: 500, error: 'internal detail arn:aws:bedrock:us-east-1:123456789012:secret-thing' });
    const res = await invoke({ prompt: 'hi', customerId: ALICE });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: PUBLIC_ERROR });
    expect(text).not.toContain('123456789012');
    await new Promise((r) => setTimeout(r, 200));
    expect(output).toContain('invocation failed');
  });

  it('is still healthy after a failed request', async () => {
    expect((await fetch(`${AGENT}/ping`)).status).toBe(200);
  });
});
