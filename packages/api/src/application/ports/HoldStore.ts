import type { HoldToken } from "../../domain/value-objects/HoldToken.js";
import type { EventId, TierId } from "../../domain/value-objects/Ids.js";

// Kind B: what is happening right now. Live availability and the holds
// against it, self-expiring. Nothing here hints at Redis; the use case
// never learns that `reserve` is a Lua script.
export interface HoldStore {
  /** Atomically reserve qty from a tier. Insufficient inventory is a value, not a throw. */
  reserve(
    tierId: TierId,
    qty: number,
    token: HoldToken,
    ttlMs: number,
  ): Promise<{ ok: true; remaining: number } | { ok: false; reason: "insufficient" }>;

  /** Compare-and-restore: only returns inventory if this token still owns the hold. */
  release(token: HoldToken): Promise<{ released: boolean }>;

  availability(eventId: EventId): Promise<ReadonlyMap<TierId, number>>;
}
