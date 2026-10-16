import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createHttp2Server, type Http2ServerRequest, type Http2Server } from 'node:http2';
import type { AddressInfo } from 'node:net';

export interface Recorded {
  method: string;
  path: string;
  body: any;
}

/** Converse API responses the fake model returns, in order. */
export type ConverseReply =
  | { text: string }
  | { toolUse: { name: string; input: unknown } }
  | { status: number; error: string };

async function readJson(req: IncomingMessage | Http2ServerRequest): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

async function listen(server: Server | Http2Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/**
 * A fake Bedrock Runtime that speaks the real Converse wire format. The agent's
 * AWS SDK reaches it through AWS_ENDPOINT_URL_BEDROCK_RUNTIME. It's an HTTP/2
 * server because the Bedrock Runtime client sends every call over HTTP/2.
 */
export class FakeBedrock {
  readonly requests: Recorded[] = [];
  private replies: ConverseReply[] = [];
  private server = createHttp2Server((req, res) => {
    void (async () => {
      const body = await readJson(req);
      this.requests.push({ method: req.method ?? '', path: decodeURIComponent(req.url ?? ''), body });
      const reply = this.replies.shift() ?? { status: 500, error: 'FakeBedrock: no reply scripted' };
      if ('status' in reply) {
        res.writeHead(reply.status, { 'content-type': 'application/json', 'x-amzn-errortype': 'InternalServerException' });
        res.end(JSON.stringify({ message: reply.error }));
        return;
      }
      const content = 'text' in reply ? [{ text: reply.text }] : [{ toolUse: { toolUseId: `t${this.requests.length}`, ...reply.toolUse } }];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          output: { message: { role: 'assistant', content } },
          stopReason: 'text' in reply ? 'end_turn' : 'tool_use',
          usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 },
          metrics: { latencyMs: 5 },
        }),
      );
    })();
  });

  url = '';
  async start(): Promise<void> {
    this.url = await listen(this.server);
  }
  script(...replies: ConverseReply[]): void {
    this.replies = replies;
    this.requests.length = 0;
  }
  async stop(): Promise<void> {
    await new Promise((r) => this.server.close(r));
  }
}

/**
 * A fake AgentCore Memory data plane (ListEvents, CreateEvent) that keeps events
 * in memory. The agent's SDK reaches it through AWS_ENDPOINT_URL_BEDROCK_AGENTCORE.
 */
export class FakeMemory {
  readonly requests: Recorded[] = [];
  readonly events: any[] = [];
  private server = createServer((req, res) => {
    void (async () => {
      const body = await readJson(req);
      const path = decodeURIComponent((req.url ?? '').split('?')[0] ?? '');
      this.requests.push({ method: req.method ?? '', path, body });
      res.setHeader('content-type', 'application/json');
      const list = /^\/memories\/([^/]+)\/actor\/([^/]+)\/sessions\/([^/]+)$/.exec(path);
      if (req.method === 'POST' && list) {
        const [, memoryId, actorId, sessionId] = list;
        res.end(JSON.stringify({ events: this.events.filter((e) => e.memoryId === memoryId && e.actorId === actorId && e.sessionId === sessionId) }));
        return;
      }
      const create = /^\/memories\/([^/]+)\/events$/.exec(path);
      if (req.method === 'POST' && create) {
        const event = { ...body, memoryId: create[1], eventId: `e${this.events.length + 1}` };
        this.events.push(event);
        res.end(JSON.stringify({ event }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ message: `FakeMemory: no route for ${req.method} ${path}` }));
    })();
  });

  url = '';
  async start(): Promise<void> {
    this.url = await listen(this.server);
  }
  async stop(): Promise<void> {
    await new Promise((r) => this.server.close(r));
  }
}
