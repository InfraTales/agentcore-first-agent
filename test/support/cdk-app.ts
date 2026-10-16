import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';

/** A CDK App with the feature flags from cdk.json, so tests see the template `cdk deploy` sees. */
export function testApp(props: cdk.AppProps = {}): cdk.App {
  const cdkJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'cdk.json'), 'utf8')) as { context: Record<string, unknown> };
  return new cdk.App({ ...props, context: { ...cdkJson.context, ...props.context } });
}
