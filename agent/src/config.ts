/**
 * Runtime settings. Every value comes from an environment variable that the CDK
 * stack sets on the AgentCore Runtime, so a missing one fails at startup, not on
 * the first customer request.
 */
export interface AgentSettings {
  region: string;
  modelId: string;
  ordersTable: string;
  memoryId: string;
  /** Hard cap on model calls per invocation. Each turn is one billed model call. */
  maxTurns: number;
  /** Hard cap on input + output tokens per invocation. */
  maxTotalTokens: number;
  /** Conversation events loaded from AgentCore Memory per request. */
  historyEvents: number;
}

export function requireEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function positiveInt(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): AgentSettings {
  return {
    region: requireEnv('AGENT_REGION', env),
    modelId: requireEnv('MODEL_ID', env),
    ordersTable: requireEnv('ORDERS_TABLE', env),
    memoryId: requireEnv('MEMORY_ID', env),
    maxTurns: positiveInt('MAX_TURNS', 6, env),
    maxTotalTokens: positiveInt('MAX_TOTAL_TOKENS', 20000, env),
    historyEvents: positiveInt('HISTORY_EVENTS', 20, env),
  };
}
