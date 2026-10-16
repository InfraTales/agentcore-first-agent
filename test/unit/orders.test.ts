import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrdersRepository } from '../../agent/src/orders';
import { ALICE, BOB, FIXTURE_ORDERS, NOW, createOrdersTable, dropTable, localClient, putOrders } from '../support/dynamodb-local';

// Every condition expression here runs against DynamoDB Local, the real engine.
const client = localClient();
let table: string;
let repo: OrdersRepository;

beforeAll(async () => {
  table = await createOrdersTable(client);
  await putOrders(client, table, FIXTURE_ORDERS);
  repo = new OrdersRepository(table, client);
});
afterAll(async () => dropTable(client, table));

describe('reads are scoped to one customer', () => {
  it("finds the customer's own order", async () => {
    expect((await repo.getOrder(ALICE, 'ORD-20260920-0001'))?.item).toBe('Trail running shoes');
  });

  it("doesn't find another customer's order, even with the right order ID", async () => {
    expect(await repo.getOrder(ALICE, 'ORD-20261001-0004')).toBeUndefined();
  });

  it("lists newest orders first and only the customer's own", async () => {
    const orders = await repo.listRecentOrders(ALICE, 10);
    expect(orders.map((o) => o.orderId)).toEqual(['ORD-20261014-0003', 'ORD-20260920-0001', 'ORD-20260801-0002']);
  });
});

describe('return requests', () => {
  it('accepts a delivered order inside the window, once', async () => {
    const first = await repo.requestReturn(ALICE, 'ORD-20260920-0001', 'Too small', NOW);
    expect(first).toEqual({ outcome: 'requested', orderId: 'ORD-20260920-0001', requestedAt: NOW.toISOString() });
    const second = await repo.requestReturn(ALICE, 'ORD-20260920-0001', 'Too small', new Date(NOW.getTime() + 1000));
    expect(second).toEqual({ outcome: 'already_requested', orderId: 'ORD-20260920-0001', requestedAt: NOW.toISOString() });
  });

  it('refuses after the 30-day window', async () => {
    expect(await repo.requestReturn(ALICE, 'ORD-20260801-0002', 'Changed my mind', NOW)).toEqual({
      outcome: 'not_eligible',
      orderId: 'ORD-20260801-0002',
      reason: 'the 30-day return window has closed',
    });
  });

  it('refuses an order that has not been delivered', async () => {
    const result = await repo.requestReturn(ALICE, 'ORD-20261014-0003', 'Ordered twice', NOW);
    expect(result).toMatchObject({ outcome: 'not_eligible', reason: 'order is shipped, not delivered' });
  });

  it("reports another customer's order as not found and leaves it untouched", async () => {
    expect(await repo.requestReturn(ALICE, 'ORD-20261001-0004', 'Broken', NOW)).toEqual({
      outcome: 'not_found',
      orderId: 'ORD-20261001-0004',
    });
    expect((await repo.getOrder(BOB, 'ORD-20261001-0004'))?.returnRequestedAt).toBeUndefined();
  });

  it('lets exactly one of ten concurrent requests win', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => repo.requestReturn(BOB, 'ORD-20261001-0004', `Attempt ${i}`, NOW)),
    );
    expect(results.filter((r) => r.outcome === 'requested')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'already_requested')).toHaveLength(9);
  });
});
