import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

export const STACK_NAME = 'OrderSupportAgent';

/** Reads the deployed stack's outputs (runtime ARN, table name and so on). */
export async function stackOutputs(): Promise<Record<string, string>> {
  const cfn = new CloudFormationClient({});
  const out = await cfn.send(new DescribeStacksCommand({ StackName: STACK_NAME }));
  const outputs = out.Stacks?.[0]?.Outputs ?? [];
  return Object.fromEntries(outputs.map((o) => [o.OutputKey ?? '', o.OutputValue ?? '']));
}

export function required(outputs: Record<string, string>, key: string): string {
  const value = outputs[key];
  if (!value) throw new Error(`Stack ${STACK_NAME} has no output ${key}. Did "npm run deploy" finish?`);
  return value;
}
