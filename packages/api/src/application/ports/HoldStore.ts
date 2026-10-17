import type { HoldToken } from "../../domain/value-objects/HoldToken.js";
import type { TierId } from "../../domain/value-objects/Ids.js";

// Kind B: what is happening right now. Live availability and the holds
// against it, self-expiring. Nothing here hints at Redis; the use case
// never learns that `reserve` is a Lua script.
//
// The store is keyed on tiers only. It does not know which event a tier
// belongs to — the caller does (EventRepository hands back an Event with
// its tiers), so availability is asked for by tier ids, not event id.
export interface HoldStore {
  /** Atomically reserve qty from a tier. Insufficient inventory is a value, not a throw. */
  reserve(
    tierId: TierId,
    qty: number,
    token: HoldToken,
    ttlMs: number,
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
}
