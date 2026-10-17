import type { Clock } from "../../src/application/ports/Clock.js";
import type { HoldStore } from "../../src/application/ports/HoldStore.js";
import { Hold } from "../../src/domain/entities/Hold.js";
import type { HoldToken } from "../../src/domain/value-objects/HoldToken.js";
import type { TierId } from "../../src/domain/value-objects/Ids.js";
import { Quantity } from "../../src/domain/value-objects/Quantity.js";

// The port's contract with none of Redis's mechanics: a counter per tier and
// a hold per token. Single-threaded, so "atomic" is free here — which is
// exactly why the concurrency test lives against the real store (TB-022).
//
// Expiry is the one Redis mechanic it does keep, on the injected clock: a
// hold past its TTL is not there any more, and — as in Redis — its quantity
// is NOT given back. The key vanishing is not a release; the sweeper
// (TB-026) is what restores it.
export class InMemoryHoldStore implements HoldStore {
  private readonly remaining = new Map<TierId, number>();
  private readonly holds = new Map<HoldToken, Hold>();

  constructor(private readonly clock: Clock) {}

  seed(tierId: TierId, remaining: number): void {
    this.remaining.set(tierId, remaining);
  }

  async reserve(
    tierId: TierId,
    qty: number,
    token: HoldToken,
    ttlMs: number,
  ): Promise<{ ok: true; remaining: number } | { ok: false; reason: "insufficient" }> {
    // A duplicate token is a test-authoring bug; silently overwriting the
    // first hold would leak its quantity, which a fake must make loud.
    if (this.holds.has(token)) throw new Error(`token ${token} already holds a reservation`);
    const current = this.remaining.get(tierId);
    if (current === undefined || current < qty) return { ok: false, reason: "insufficient" };
    const hold = Hold.create({
      token,
      tierId,
      qty: Quantity.of(qty),
      now: this.clock.now(),
      ttlMs,
    });
    const left = current - qty;
    this.remaining.set(tierId, left);
    this.holds.set(token, hold);
    return { ok: true, remaining: left };
  }

  async release(
    token: HoldToken,
  ): Promise<{ released: true; tierId: TierId; remaining: number } | { released: false }> {
    const hold = this.live(token);
    if (hold === null) return { released: false };
    this.holds.delete(token);
    const restored = (this.remaining.get(hold.tierId) ?? 0) + hold.qty.value;
    this.remaining.set(hold.tierId, restored);
    return { released: true, tierId: hold.tierId, remaining: restored };
  }

  async availability(tierIds: readonly TierId[]): Promise<ReadonlyMap<TierId, number>> {
    const result = new Map<TierId, number>();
    for (const tierId of tierIds) {
      const count = this.remaining.get(tierId);
      if (count !== undefined) result.set(tierId, count);
    }
    return result;
  }

  async find(token: HoldToken): Promise<Hold | null> {
    return this.live(token);
  }

  private live(token: HoldToken): Hold | null {
    const hold = this.holds.get(token);
    if (hold === undefined || hold.isExpired(this.clock.now())) return null;
    return hold;
  }
}
