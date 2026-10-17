import type { Order } from "../../domain/entities/Order.js";

// Kind A: what happened. One transaction: the order, its items, and the
// hold's row flipped to 'converted' — the three facts that make "a hold that
// got confirmed" true together or not at all (TB-007 decision 10, TB-010's
// disjoint sums). Throws when the hold has no active row to flip (nothing is
// written) and IdempotencyKeyReused when the key is already an order's.
export interface OrderRepository {
  save(order: Order): Promise<void>;
}
