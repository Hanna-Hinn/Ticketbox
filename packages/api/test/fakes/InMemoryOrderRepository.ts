import type { OrderRepository } from "../../src/application/ports/OrderRepository.js";
import type { Order } from "../../src/domain/entities/Order.js";
import { IdempotencyKeyReused } from "../../src/domain/errors/IdempotencyKeyReused.js";
import type { OrderId } from "../../src/domain/value-objects/Ids.js";
import type { InMemoryHoldRepository } from "./InMemoryHoldRepository.js";

// The order's transaction on a Map, with the rules the real one enforces:
// one order per hold, one order per idempotency key, and the hold's row
// flipped to 'converted' in the same step — or nothing written at all.
export class InMemoryOrderRepository implements OrderRepository {
  private readonly orders = new Map<OrderId, Order>();

  constructor(private readonly holdRows: InMemoryHoldRepository) {}

  async save(order: Order): Promise<void> {
    const existing = [...this.orders.values()];
    if (
      order.idempotencyKey !== null &&
      existing.some((o) => o.idempotencyKey === order.idempotencyKey)
    ) {
      throw new IdempotencyKeyReused();
    }
    if (existing.some((o) => o.holdToken === order.holdToken)) {
      throw new Error(`hold ${order.holdToken} already has an order`);
    }
    if (this.holdRows.statusOf(order.holdToken) !== "active") {
      throw new Error(`hold ${order.holdToken} has no active row to convert`);
    }
    await this.holdRows.setStatus(order.holdToken, "converted");
    this.orders.set(order.id, order);
  }

  saved(id: OrderId): Order | undefined {
    return this.orders.get(id);
  }

  get size(): number {
    return this.orders.size;
  }
}
