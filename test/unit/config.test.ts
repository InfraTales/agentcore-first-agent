import { describe, expect, it } from 'vitest';
import { loadSettings, requireEnv } from '../../agent/src/config';

const base = { AGENT_REGION: 'us-east-1', MODEL_ID: 'us.amazon.nova-2-lite-v1:0', ORDERS_TABLE: 'orders', MEMORY_ID: 'mem-1' };

describe('settings', () => {
  it('reads required values and applies the budget defaults', () => {
    expect(loadSettings(base)).toEqual({
      region: 'us-east-1',
      modelId: 'us.amazon.nova-2-lite-v1:0',
      ordersTable: 'orders',
      memoryId: 'mem-1',
      maxTurns: 6,
      maxTotalTokens: 20000,
      historyEvents: 20,
    });
  });

  it.each(['AGENT_REGION', 'MODEL_ID', 'ORDERS_TABLE', 'MEMORY_ID'])('fails at startup without %s', (name) => {
    expect(() => loadSettings({ ...base, [name]: '' })).toThrow(`Missing required environment variable ${name}`);
  });

  it('rejects a budget that is not a positive integer', () => {
    expect(() => loadSettings({ ...base, MAX_TURNS: '0' })).toThrow('MAX_TURNS must be a positive integer');
    expect(() => loadSettings({ ...base, MAX_TOTAL_TOKENS: 'lots' })).toThrow('MAX_TOTAL_TOKENS');
  });

  it('treats whitespace as missing', () => {
    expect(() => requireEnv('X', { X: '   ' })).toThrow('Missing required environment variable X');
  });
});
