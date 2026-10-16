import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import type { Order } from '../../agent/src/orders';

/**
 * DynamoDB Local, the real engine. Locally: docker run -d -p 8019:8000 amazon/dynamodb-local
 * CI runs it as a service container. Tests fail, not skip, when it's missing.
 */
export const DYNAMODB_ENDPOINT = process.env.AWS_ENDPOINT_URL_DYNAMODB ?? 'http://localhost:8019';

export function localClient(): DynamoDBClient {
  return new DynamoDBClient({
    endpoint: DYNAMODB_ENDPOINT,
    region: 'us-east-1',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
}

export async function createOrdersTable(client: DynamoDBClient): Promise<string> {
  const name = `orders-${randomUUID()}`;
  await client.send(
    new CreateTableCommand({
      TableName: name,
      AttributeDefinitions: [
        { AttributeName: 'customerId', AttributeType: 'S' },
        { AttributeName: 'orderId', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'customerId', KeyType: 'HASH' },
        { AttributeName: 'orderId', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  );
  return name;
}

export async function dropTable(client: DynamoDBClient, name: string): Promise<void> {
  await client.send(new DeleteTableCommand({ TableName: name }));
}

export async function putOrders(client: DynamoDBClient, table: string, orders: Order[]): Promise<void> {
  const doc = DynamoDBDocumentClient.from(client);
  await doc.send(new BatchWriteCommand({ RequestItems: { [table]: orders.map((o) => ({ PutRequest: { Item: o } })) } }));
}

export const NOW = new Date('2026-10-16T12:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

export const ALICE = 'cus_alice0001';
export const BOB = 'cus_bob000002';

/** Two customers' orders, covering each return rule. */
export const FIXTURE_ORDERS: Order[] = [
  { customerId: ALICE, orderId: 'ORD-20260920-0001', status: 'DELIVERED', item: 'Trail running shoes', totalCents: 12900, placedAt: daysAgo(26), deliveredAt: daysAgo(20) },
  { customerId: ALICE, orderId: 'ORD-20260801-0002', status: 'DELIVERED', item: 'Rain jacket', totalCents: 8900, placedAt: daysAgo(76), deliveredAt: daysAgo(70) },
  { customerId: ALICE, orderId: 'ORD-20261014-0003', status: 'SHIPPED', item: 'Headlamp', totalCents: 3500, placedAt: daysAgo(2) },
  { customerId: BOB, orderId: 'ORD-20261001-0004', status: 'DELIVERED', item: 'Espresso grinder', totalCents: 24900, placedAt: daysAgo(15), deliveredAt: daysAgo(10) },
];
