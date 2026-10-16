/**
 * Measures the agent process's CPU time and memory per invocation on this machine.
 * Starts build/agent/index.js against the contract-test fakes (fake Bedrock, fake
 * Memory, DynamoDB Local) and sends 200 invocations that each make one tool call.
 * Model latency is zero here, so this is the agent's own work only.
 *   AWS_ENDPOINT_URL_DYNAMODB=http://localhost:8019 npm run bundle && npx tsx scripts/measure-cpu.ts
 */
import { execFileSync, spawn } from 'node:child_process';
import * as path from 'node:path';
import { FakeBedrock, FakeMemory, type ConverseReply } from '../test/contract/fakes';
import { ALICE, DYNAMODB_ENDPOINT, FIXTURE_ORDERS, createOrdersTable, dropTable, localClient, putOrders } from '../test/support/dynamodb-local';

const N = 200;
const cpuSeconds = (pid: number) => {
  const [m, s] = execFileSync('ps', ['-o', 'cputime=', '-p', String(pid)], { encoding: 'utf8' }).trim().split(':').slice(-2);
  return Number(m) * 60 + Number(s);
};
const rssMb = (pid: number) => Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) / 1024;

async function main() {
  const bedrock = new FakeBedrock();
  const memory = new FakeMemory();
  await Promise.all([bedrock.start(), memory.start()]);
  const ddb = localClient();
  const table = await createOrdersTable(ddb);
  await putOrders(ddb, table, FIXTURE_ORDERS);
  const agent = spawn(process.env.AGENT_NODE ?? process.execPath, [path.join(__dirname, '..', 'build', 'agent', 'index.js')], {
    env: {
      PATH: process.env.PATH, AGENT_REGION: 'us-east-1', MODEL_ID: 'us.amazon.nova-2-lite-v1:0', ORDERS_TABLE: table, MEMORY_ID: 'm',
      AWS_ACCESS_KEY_ID: 'local', AWS_SECRET_ACCESS_KEY: 'local', AWS_ENDPOINT_URL_BEDROCK_RUNTIME: bedrock.url,
      AWS_ENDPOINT_URL_BEDROCK_AGENTCORE: memory.url, AWS_ENDPOINT_URL_DYNAMODB: DYNAMODB_ENDPOINT,
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch('http://127.0.0.1:8080/ping')).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  const pid = agent.pid!;
  const startupCpu = cpuSeconds(pid);
  const startupRss = rssMb(pid);
  const script: ConverseReply[] = [];
  for (let i = 0; i < N; i++) script.push({ toolUse: { name: 'lookup_order', input: { orderId: 'ORD-20260920-0001' } } }, { text: 'Delivered.' });
  bedrock.script(...script);
  for (let i = 0; i < N; i++) {
    const res = await fetch('http://127.0.0.1:8080/invocations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': 'measure-session-000000000000000000001' },
      body: JSON.stringify({ prompt: 'Where is ORD-20260920-0001?', customerId: ALICE }),
    });
    if (!res.ok) throw new Error(await res.text());
  }
  const used = cpuSeconds(pid) - startupCpu;
  console.log(`startup: ${startupCpu.toFixed(2)} s CPU, ${startupRss.toFixed(0)} MB RSS`);
  console.log(`per invocation: ${((used / N) * 1000).toFixed(1)} ms CPU; RSS after ${N}: ${rssMb(pid).toFixed(0)} MB`);
  agent.kill();
  await Promise.all([bedrock.stop(), memory.stop()]);
  await dropTable(ddb, table);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
