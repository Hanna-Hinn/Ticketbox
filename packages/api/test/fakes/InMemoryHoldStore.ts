import type { Clock } from "../../src/application/ports/Clock.js";
import type { ExpiredHold, HoldStore, SweepResult } from "../../src/application/ports/HoldStore.js";
import type { HeldEntry, InventoryRepair } from "../../src/application/ports/InventoryRepair.js";
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
// (TB-026) is what restores it, through expired() and sweep(), which see
// the holds the other methods hide.
//
// One place it is stricter than Redis, on purpose, because it is a
// test-authoring bug the fake should make loud: a reused token throws even
// if the earlier hold has expired (Redis would accept the write on a
// vanished key).
export class InMemoryHoldStore implements HoldStore, InventoryRepair {
  private readonly remaining = new Map<TierId, number>();
  private readonly holds = new Map<HoldToken, Hold>();
  // What an eviction does to one key and not another, for reconciliation's
  // tests: a hash gone while its index entry stays (evictHash — find()
  // answers null, held() and expired() still list it), or a tier's whole
  // index gone while its hashes live (evictIndex — held() and expired()
  // list nothing, find() still answers).
  private readonly evictedHashes = new Set<HoldToken>();
  private readonly evictedIndexes = new Set<TierId>();

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
    if (this.evictedHashes.has(token)) return null;
    return this.live(token);
  }

  async expired(now: Date): Promise<readonly ExpiredHold[]> {
    return [...this.holds.values()]
      .filter((hold) => hold.isExpired(now) && !this.evictedIndexes.has(hold.tierId))
      .map((hold) => ({ token: hold.token, tierId: hold.tierId, qty: hold.qty.value }));
  }

  async sweep(hold: ExpiredHold, now: Date): Promise<SweepResult> {
    const held = this.holds.get(hold.token);
    if (held === undefined || this.evictedIndexes.has(held.tierId)) return { swept: false };
    // As strict as Redis: the real store looks up the member the argument
    // re-encodes to, so a wrong qty or tier finds nothing.
    if (held.qty.value !== hold.qty || held.tierId !== hold.tierId) return { swept: false };
    if (!held.isExpired(now)) return { swept: false };
    this.holds.delete(hold.token);
    const current = this.remaining.get(held.tierId);
    if (current === undefined) return { swept: true, restored: false };
    const restored = current + held.qty.value;
    this.remaining.set(held.tierId, restored);
    return { swept: true, restored: true, remaining: restored };
  }

  async consume(token: HoldToken): Promise<boolean> {
    // Sold, not released: the quantity stays out of the counter.
    const hold = this.live(token);
    if (hold === null) return false;
    this.holds.delete(token);
    return true;
  }

  async held(tierId: TierId): Promise<readonly HeldEntry[]> {
    if (this.evictedIndexes.has(tierId)) return [];
    return [...this.holds.values()]
      .filter((hold) => hold.tierId === tierId)
      .map((hold) => ({ token: hold.token, qty: hold.qty.value }));
  }

  async rebuild(tierId: TierId, remaining: number): Promise<{ before: number | null }> {
    const before = this.remaining.get(tierId) ?? null;
    this.remaining.set(tierId, remaining);
    return { before };
  }

  /** Test-only: drop a hold's record the way an eviction would, keeping its index entry. */
  evictHash(token: HoldToken): void {
    if (!this.holds.has(token)) throw new Error(`no hold ${token} to evict`);
    this.evictedHashes.add(token);
  }

  /** Test-only: drop a tier's whole index the way an eviction would, keeping its holds. */
  evictIndex(tierId: TierId): void {
    this.evictedIndexes.add(tierId);
  }

  private live(token: HoldToken): Hold | null {
    const hold = this.holds.get(token);
    if (hold === undefined || hold.isExpired(this.clock.now())) return null;
    return hold;
  }
}
