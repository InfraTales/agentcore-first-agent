import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';

/** Returns are allowed for this many days after delivery. A business rule, not an AWS limit. */
export const RETURN_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface Order {
  customerId: string;
  orderId: string;
  status: 'PLACED' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED';
  item: string;
  totalCents: number;
  placedAt: string;
  deliveredAt?: string;
  returnRequestedAt?: string;
  returnReason?: string;
}

export type ReturnResult =
  | { outcome: 'requested'; orderId: string; requestedAt: string }
  | { outcome: 'already_requested'; orderId: string; requestedAt: string }
  | { outcome: 'not_eligible'; orderId: string; reason: string }
  | { outcome: 'not_found'; orderId: string };

/**
 * Data access for the orders table. The partition key is the customer ID, so every
 * read and write is scoped to one customer by the key itself. There is no method
 * that takes an order ID alone.
 */
export class OrdersRepository {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    client: DynamoDBClient = new DynamoDBClient({}),
  ) {
    this.doc = DynamoDBDocumentClient.from(client);
  }

  async getOrder(customerId: string, orderId: string): Promise<Order | undefined> {
    const out = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { customerId, orderId }, ConsistentRead: true }),
    );
    return out.Item as Order | undefined;
  }

  async listRecentOrders(customerId: string, limit: number): Promise<Order[]> {
    const out = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'customerId = :c',
        ExpressionAttributeValues: { ':c': customerId },
        ScanIndexForward: false, // order IDs sort by time, newest first
        Limit: limit,
      }),
    );
    return (out.Items ?? []) as Order[];
  }

  /**
   * One conditional write decides eligibility, so two concurrent requests for the
   * same order can't both succeed, and a stale read can't approve a late return.
   */
  async requestReturn(customerId: string, orderId: string, reason: string, now: Date): Promise<ReturnResult> {
    const requestedAt = now.toISOString();
    const cutoff = new Date(now.getTime() - RETURN_WINDOW_DAYS * DAY_MS).toISOString();
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { customerId, orderId },
          UpdateExpression: 'SET returnRequestedAt = :now, returnReason = :reason',
          ConditionExpression:
            'attribute_exists(orderId) AND #status = :delivered AND deliveredAt >= :cutoff AND attribute_not_exists(returnRequestedAt)',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':now': requestedAt, ':reason': reason, ':delivered': 'DELIVERED', ':cutoff': cutoff },
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        }),
      );
      return { outcome: 'requested', orderId, requestedAt };
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
      return explainRejection(orderId, err.Item ? (unmarshall(err.Item) as Order) : undefined, cutoff);
    }
  }
}

function explainRejection(orderId: string, old: Order | undefined, cutoff: string): ReturnResult {
  if (!old) return { outcome: 'not_found', orderId };
  if (old.returnRequestedAt) return { outcome: 'already_requested', orderId, requestedAt: old.returnRequestedAt };
  if (old.status !== 'DELIVERED') return { outcome: 'not_eligible', orderId, reason: `order is ${old.status.toLowerCase()}, not delivered` };
  if (!old.deliveredAt || old.deliveredAt < cutoff) {
    return { outcome: 'not_eligible', orderId, reason: `the ${RETURN_WINDOW_DAYS}-day return window has closed` };
  }
  return { outcome: 'not_eligible', orderId, reason: 'order changed while the request was processed' };
}
