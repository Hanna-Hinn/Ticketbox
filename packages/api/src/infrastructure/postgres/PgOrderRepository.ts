import type pg from "pg";
import type { OrderRepository } from "../../application/ports/OrderRepository.js";
import type { Order } from "../../domain/entities/Order.js";
import { IdempotencyKeyReused } from "../../domain/errors/IdempotencyKeyReused.js";

// Kind A: what happened. The order, its items and the hold's flip to
// 'converted' are one transaction, so the computed count never sees a
// ticket as both held and sold, nor as neither (TB-010's disjoint sums).
// A Pool, not a client: this adapter owns its transaction.
const UNIQUE_VIOLATION = "23505";

export class PgOrderRepository implements OrderRepository {
  constructor(private readonly pool: pg.Pool) {}

  async save(order: Order): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // First, and exactly one row: a hold with no active row — none at all,
      // or one already expired or released — cannot be confirmed (ADR 0007).
      // First also takes the row lock before anything is inserted, so a
      // reconcile racing this confirm waits here instead of between the
      // inserts and the flip.
      const flipped = await client.query(
        `UPDATE holds SET status = 'converted' WHERE token = $1 AND status = 'active'`,
        [order.holdToken],
      );
      if (flipped.rowCount !== 1) {
        throw new Error(`hold ${order.holdToken} has no active row to convert`);
      }
      await client.query(
        `INSERT INTO orders (id, hold_token, email, total_cents, created_at, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          order.id,
          order.holdToken,
          order.email,
          order.total().cents,
          order.createdAt,
          order.idempotencyKey,
        ],
      );
      for (const item of order.items) {
        await client.query(
          `INSERT INTO order_items (id, order_id, tier_id, qty, unit_price_cents)
           VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
          [order.id, item.tierId, item.qty.value, item.unitPrice.cents],
        );
      }
      await client.query("COMMIT");
      client.release();
    } catch (err: unknown) {
      // A client whose ROLLBACK could not be confirmed is not handed back to
      // the pool mid-transaction; one that rolled back cleanly is reusable —
      // a refused idempotency key must not cost the pool a connection.
      const rolledBack = await client.query("ROLLBACK").then(
        () => true,
        () => false,
      );
      client.release(rolledBack ? undefined : new Error("rollback failed"));
      throw translate(err);
    }
  }
}

// The one constraint a client can violate on its own becomes the domain's
// word for it; every other failure is what it is.
function translate(err: unknown): unknown {
  if (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    err.code === UNIQUE_VIOLATION &&
    "constraint" in err &&
    err.constraint === "orders_idempotency_key_key"
  ) {
    return new IdempotencyKeyReused();
  }
  return err;
}
