import type { Hold } from "../../domain/entities/Hold.js";
import type { HoldToken } from "../../domain/value-objects/HoldToken.js";
import type { TierId } from "../../domain/value-objects/Ids.js";

// Kind B: what is happening right now. Live availability and the holds
// against it, self-expiring. Nothing here hints at Redis; the use case
// never learns that `reserve` is a Lua script.
//
// The store is keyed on tiers only. It does not know which event a tier
// belongs to — the caller does (EventRepository hands back an Event with
// its tiers), so availability is asked for by tier ids, not event id.

// An entry of the store's expiry index: what the sweeper needs and nothing
// the hold hash had — by the time it may be swept, the hash is gone.
export interface ExpiredHold {
  readonly token: HoldToken;
  readonly tierId: TierId;
  readonly qty: number;
}

// swept: false — someone else already did (a late release, another sweeper);
// restored: false — the tier has no counter to restore into (evicted): the
// entry is removed and nothing is added back, reconciliation rebuilds it.
export type SweepResult =
  | { swept: true; restored: true; remaining: number }
  | { swept: true; restored: false }
  | { swept: false };

export interface HoldStore {
  /**
   * Atomically reserve hold.qty from hold.tierId under hold.token, expiring
   * at hold.expiresAt. Insufficient inventory is a value, not a throw. The
   * entity carries every instant, so one clock — the use case's — sets the
   * expiry the client sees, the store's index, and the hold's own record.
   */
  reserve(
    hold: Hold,
  ): Promise<{ ok: true; remaining: number } | { ok: false; reason: "insufficient" }>;

  /**
   * Compare-and-restore: only returns inventory if this token still owns the
   * hold. On success the store already knows the tier and the new count, so
   * it hands them back — the caller only has a token and could not ask again.
   */
  release(
    token: HoldToken,
  ): Promise<{ released: true; tierId: TierId; remaining: number } | { released: false }>;

  availability(tierIds: readonly TierId[]): Promise<ReadonlyMap<TierId, number>>;

  /**
   * The live hold, or null once it has expired or never existed — the two are
   * one answer here, as they are for a key Redis has dropped.
   */
  find(token: HoldToken): Promise<Hold | null>;

  /** Every hold whose expiry is at or before `now`, as the store's index sees them. */
  expired(now: Date): Promise<readonly ExpiredHold[]>;

  /** Restore an expired hold's quantity exactly once (TB-026). */
  sweep(hold: ExpiredHold, now: Date): Promise<SweepResult>;
}
