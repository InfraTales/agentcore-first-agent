/**
 * Writes sample orders for two customers into the deployed table, dated relative
 * to today so the return window rules have something to check.
 * Run after deploy: npm run seed
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { Order } from '../agent/src/orders';
import { required, stackOutputs } from './stack-outputs';

const day = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * day).toISOString();
const id = (d: number, n: number) => `ORD-${ago(d).slice(0, 10).replaceAll('-', '')}-${String(n).padStart(4, '0')}`;

export const SAMPLE_ORDERS: Order[] = [
  { customerId: 'cus_alice0001', orderId: id(26, 1), status: 'DELIVERED', item: 'Trail running shoes', totalCents: 12900, placedAt: ago(26), deliveredAt: ago(20) },
  { customerId: 'cus_alice0001', orderId: id(76, 2), status: 'DELIVERED', item: 'Rain jacket', totalCents: 8900, placedAt: ago(76), deliveredAt: ago(70) },
  { customerId: 'cus_alice0001', orderId: id(2, 3), status: 'SHIPPED', item: 'Headlamp', totalCents: 3500, placedAt: ago(2) },
  { customerId: 'cus_bob000002', orderId: id(15, 4), status: 'DELIVERED', item: 'Espresso grinder', totalCents: 24900, placedAt: ago(15), deliveredAt: ago(10) },
];

async function main() {
  const table = required(await stackOutputs(), 'OrdersTableName');
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  await doc.send(new BatchWriteCommand({ RequestItems: { [table]: SAMPLE_ORDERS.map((Item) => ({ PutRequest: { Item } })) } }));
  for (const o of SAMPLE_ORDERS) console.log(`${o.customerId}  ${o.orderId}  ${o.status.padEnd(9)}  ${o.item}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
