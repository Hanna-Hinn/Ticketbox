import type pg from "pg";
import type { HoldOutcome, HoldRepository } from "../../application/ports/HoldRepository.js";
import type { Hold } from "../../domain/entities/Hold.js";
import type { HoldToken } from "../../domain/value-objects/HoldToken.js";

// Kind A: the audit trail of a hold, written after Redis has decided it and
// never consulted on the hot path (ADR 0004). Its active rows are what the
// computed count subtracts (PgEventRepository), so a row that lags the
// store under-reports until the sweeper or reconcile catches up — it never
// over-sells.
export class PgHoldRepository implements HoldRepository {
  constructor(private readonly db: pg.Pool | pg.ClientBase) {}

  async save(hold: Hold): Promise<void> {
    // The hold's own instants, not DEFAULT now(): one clock (TB-022). A
    // duplicate token is the primary key's problem, and a bug, so it throws.
    await this.db.query(
      `INSERT INTO holds (token, tier_id, qty, status, expires_at, created_at)
       VALUES ($1, $2, $3, 'active', $4, $5)`,
      [hold.token, hold.tierId, hold.qty.value, hold.expiresAt, hold.createdAt],
    );
  }

  async setStatus(token: HoldToken, status: HoldOutcome): Promise<void> {
    // Only out of 'active': the audit trail keeps the first outcome, so the
    // sweeper marking a released hold expired (or the reverse) changes
    // nothing. Matching no row at all is not an error at this port — a
    // hold whose save failed has no row to mark.
    await this.db.query(`UPDATE holds SET status = $2 WHERE token = $1 AND status = 'active'`, [
      token,
      status,
    ]);
  }
}
