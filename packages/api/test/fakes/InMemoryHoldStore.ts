import type { Clock } from "../../src/application/ports/Clock.js";
import type { HoldStore } from "../../src/application/ports/HoldStore.js";
import type { Hold } from "../../src/domain/entities/Hold.js";
import type { HoldToken } from "../../src/domain/value-objects/HoldToken.js";
import type { TierId } from "../../src/domain/value-objects/Ids.js";

// The port's contract with none of Redis's mechanics: a counter per tier and
// a hold per token. Single-threaded, so "atomic" is free here — which is
// exactly why the concurrency test lives against the real store (TB-022).
//
// Expiry is the one Redis mechanic it does keep, on the injected clock: a
// hold past its TTL is not there any more, and — as in Redis — its quantity
// is NOT given back. The key vanishing is not a release; the sweeper
// (TB-026) is what restores it.
//
// One place it is stricter than Redis, on purpose, because it is a
// test-authoring bug the fake should make loud: a reused token throws even
// if the earlier hold has expired (Redis would accept the write on a
// vanished key).
export class InMemoryHoldStore implements HoldStore {
  private readonly remaining = new Map<TierId, number>();
  private readonly holds = new Map<HoldToken, Hold>();

  constructor(private readonly clock: Clock) {}

  seed(tierId: TierId, remaining: number): void {
    this.remaining.set(tierId, remaining);
  }

  async reserve(
    hold: Hold,
  ): Promise<{ ok: true; remaining: number } | { ok: false; reason: "insufficient" }> {
    // A duplicate token is a test-authoring bug; silently overwriting the
    // first hold would leak its quantity, which a fake must make loud.
    // Expired holds count too (see the header): stricter than Redis here.
    if (this.holds.has(hold.token)) {
      throw new Error(`token ${hold.token} already holds a reservation`);
    }
    const current = this.remaining.get(hold.tierId);
    if (current === undefined || current < hold.qty.value) {
      return { ok: false, reason: "insufficient" };
    }
    const left = current - hold.qty.value;
    this.remaining.set(hold.tierId, left);
    this.holds.set(hold.token, hold);
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
