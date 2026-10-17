import type { HoldStore } from "../../src/application/ports/HoldStore.js";
import type { HoldToken } from "../../src/domain/value-objects/HoldToken.js";
import type { TierId } from "../../src/domain/value-objects/Ids.js";

// The port's contract with none of Redis's mechanics: a counter per tier and
// a record per token. Single-threaded, so "atomic" is free here — which is
// exactly why the concurrency test lives against the real store (TB-022).
export class InMemoryHoldStore implements HoldStore {
  private readonly remaining = new Map<TierId, number>();
  private readonly holds = new Map<HoldToken, { tierId: TierId; qty: number; ttlMs: number }>();

  seed(tierId: TierId, remaining: number): void {
    this.remaining.set(tierId, remaining);
  }

  async reserve(
    tierId: TierId,
    qty: number,
    token: HoldToken,
    ttlMs: number,
  ): Promise<{ ok: true; remaining: number } | { ok: false; reason: "insufficient" }> {
    const current = this.remaining.get(tierId);
    if (current === undefined || current < qty) return { ok: false, reason: "insufficient" };
    const left = current - qty;
    this.remaining.set(tierId, left);
    this.holds.set(token, { tierId, qty, ttlMs });
    return { ok: true, remaining: left };
  }

  async release(
    token: HoldToken,
  ): Promise<{ released: true; tierId: TierId; remaining: number } | { released: false }> {
    const hold = this.holds.get(token);
    if (hold === undefined) return { released: false };
    this.holds.delete(token);
    const restored = (this.remaining.get(hold.tierId) ?? 0) + hold.qty;
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
}
