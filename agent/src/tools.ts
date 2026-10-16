import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import type { Order, OrdersRepository } from './orders';

export const ORDER_ID = /^ORD-\d{8}-\d{4}$/;

/** What the model sees about an order. Internal fields stay out of the context window. */
export function publicView(order: Order) {
  return {
    orderId: order.orderId,
    status: order.status,
    item: order.item,
    total: `$${(order.totalCents / 100).toFixed(2)}`,
    placedAt: order.placedAt.slice(0, 10),
    deliveredAt: order.deliveredAt?.slice(0, 10) ?? null,
    returnRequested: order.returnRequestedAt !== undefined,
  };
}

/**
 * Builds the tools for one request. The customer ID is captured here, from the
 * trusted request, and is never a tool parameter. A prompt injection can make the
 * model ask for any order ID, but the lookup still runs inside this customer's
 * partition, so another customer's order comes back as not found.
 */
export function buildTools(repo: OrdersRepository, customerId: string, now: () => Date, onError: (err: unknown) => void = () => {}) {
  // A thrown error becomes the tool result text, which the model reads and may repeat
  // to the customer. Table names and AWS error messages stay in the log instead.
  const safely =
    <I, O>(fn: (input: I) => Promise<O>) =>
    async (input: I): Promise<O | { outcome: 'unavailable'; message: string }> => {
      try {
        return await fn(input);
      } catch (err) {
        onError(err);
        return { outcome: 'unavailable', message: 'The order system is not responding. Ask the customer to try again later.' };
      }
    };

  const orderIdSchema = z.string().regex(ORDER_ID).describe('Order ID, for example ORD-20260914-0001');

  const lookupOrder = tool({
    name: 'lookup_order',
    description: "Get the status of one of the customer's orders by order ID.",
    inputSchema: z.object({ orderId: orderIdSchema }),
    callback: safely(async ({ orderId }: { orderId: string }) => {
      const order = await repo.getOrder(customerId, orderId);
      return order ? publicView(order) : { outcome: 'not_found', orderId };
    }),
  });

  const listRecentOrders = tool({
    name: 'list_recent_orders',
    description: "List the customer's most recent orders, newest first.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(10).default(5) }),
    callback: safely(async ({ limit }: { limit: number }) => {
      const orders = await repo.listRecentOrders(customerId, limit);
      return { orders: orders.map(publicView) };
    }),
  });

  const requestReturn = tool({
    name: 'request_return',
    description: 'Start a return for a delivered order. Only call this after the customer confirmed the order and reason.',
    inputSchema: z.object({
      orderId: orderIdSchema,
      reason: z.string().trim().min(3).max(300).describe("The customer's reason, in their words"),
    }),
    callback: safely(({ orderId, reason }: { orderId: string; reason: string }) =>
      repo.requestReturn(customerId, orderId, reason, now()),
    ),
  });

  return [lookupOrder, listRecentOrders, requestReturn];
}
