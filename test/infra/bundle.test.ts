/**
 * AgentCore Runtime starts `node index.js` from the zip with the NODE_22 managed
 * runtime. Check that index.js is one self-contained CommonJS file that starts.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { builtinModules } from 'node:module';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUNDLE_DIR } from '../../infra/lib/order-agent-stack';

const meta = JSON.parse(fs.readFileSync(path.join(BUNDLE_DIR, '..', 'meta.json'), 'utf8')) as {
  outputs: Record<string, { imports: { path: string; external?: boolean }[]; inputs: Record<string, unknown> }>;
};

describe('agent bundle', () => {
  it('holds index.js at the zip root with only its source map beside it', () => {
    expect(fs.readdirSync(BUNDLE_DIR).sort()).toEqual(['index.js', 'index.js.map']);
  });

  it('imports nothing outside Node.js itself', () => {
    // esbuild's metafile lists every import it left unbundled. Only Node built-ins may remain,
    // plus two optional add-ons that ws loads inside try/catch.
    const builtins = new Set([...builtinModules, 'bufferutil', 'utf-8-validate']);
    const external = Object.values(meta.outputs)
      .flatMap((o) => o.imports)
      .filter((i) => i.external)
      .map((i) => i.path.replace(/^node:/, ''))
      .filter((p) => !builtins.has(p));
    expect([...new Set(external)]).toEqual([]);
  });

  it('includes the agent framework and the AgentCore runtime server', () => {
    const inputs = Object.values(meta.outputs).flatMap((o) => Object.keys(o.inputs));
    expect(inputs.some((i) => i.includes('node_modules/@strands-agents/sdk/'))).toBe(true);
    expect(inputs.some((i) => i.includes('node_modules/bedrock-agentcore/dist/src/runtime/'))).toBe(true);
  });

  it('loads and fails fast on a missing setting instead of serving broken requests', () => {
    const run = spawnSync(process.execPath, [path.join(BUNDLE_DIR, 'index.js')], {
      env: { PATH: process.env.PATH },
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('Missing required environment variable AGENT_REGION');
  });
});
