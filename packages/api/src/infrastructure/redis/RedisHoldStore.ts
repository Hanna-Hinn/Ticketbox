import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { HoldStore } from "../../application/ports/HoldStore.js";
import { Hold } from "../../domain/entities/Hold.js";
import type { HoldToken } from "../../domain/value-objects/HoldToken.js";
import { tierId, type TierId } from "../../domain/value-objects/Ids.js";
import { Quantity } from "../../domain/value-objects/Quantity.js";
import { describeRedisError } from "./client.js";
import { keys } from "./keys.js";
import { defineHoldScripts } from "./scripts.js";
import { CACHE_COMMAND_DEADLINE_MS, within } from "./within.js";

// create_hold.lua's reply contract.
const INSUFFICIENT = -1;
const NO_COUNTER = -2;

// The live truth about holds: a counter per tier, a hash per hold with the
// hold's own TTL, a sorted set per tier for the sweeper. Writes fail closed
// (a store that cannot be reached is an error, never "insufficient");
// reads fail open to the computed count (ADR 0002).
export class RedisHoldStore implements HoldStore {
  constructor(
    private readonly redis: Redis,
    private readonly log: Logger,
  ) {
    defineHoldScripts(redis);
  }

  async reserve(
    hold: Hold,
  ): Promise<{ ok: true; remaining: number } | { ok: false; reason: "insufficient" }> {
    this.requireReady("reserve");
    // Every instant comes from the hold, i.e. from the use case's Clock:
    // the expiry the client counts down to, the score the sweeper sorts by
    // and the hash's own field are one number. Only the key's TTL is
    // relative, and so on Redis's clock.
    const left = await this.redis.createHold(
      keys.tier(hold.tierId),
      keys.hold(hold.token),
      keys.tierHolds(hold.tierId),
      hold.qty.value,
      hold.token,
      hold.tierId,
      hold.createdAt.getTime(),
      hold.expiresAt.getTime(),
      hold.expiresAt.getTime() - hold.createdAt.getTime(),
    );
    if (left === NO_COUNTER) {
      // Reads fall back to the computed count for this tier (ADR 0002); the
      // write side refuses, and says so, until reconciliation seeds it.
      this.log.warn(
        { tierId: hold.tierId, key: keys.tier(hold.tierId) },
        "no live counter for tier; refusing holds until it is reconciled",
      );
      return { ok: false, reason: "insufficient" };
    }
    if (left === INSUFFICIENT) return { ok: false, reason: "insufficient" };
    return { ok: true, remaining: left };
  }

  async release(): Promise<
    { released: true; tierId: TierId; remaining: number } | { released: false }
  > {
    // The only correct release is a compare-and-restore script, which is
    // TB-023's whole lesson; a DEL here would release someone else's hold.
    throw new Error("HoldStore.release is not implemented until TB-023 (release_hold.lua)");
  }

  async availability(tierIds: readonly TierId[]): Promise<ReadonlyMap<TierId, number>> {
    const result = new Map<TierId, number>();
    if (this.redis.status !== "ready") return result;
    let counts: (string | null)[];
    try {
      counts = await within(
        Promise.all(tierIds.map((id) => this.redis.hget(keys.tier(id), "remaining"))),
        CACHE_COMMAND_DEADLINE_MS,
      );
    } catch (err: unknown) {
      this.log.warn({ err: describeRedisError(err) }, "live counts unavailable; computed counts");
      return result;
    }
    tierIds.forEach((id, i) => {
      const count = counts[i];
      if (count !== null && count !== undefined) result.set(id, Number(count));
    });
    return result;
  }

  async find(token: HoldToken): Promise<Hold | null> {
    this.requireReady("find");
    const fields = await this.redis.hgetall(keys.hold(token));
    // HGETALL on a key that does not exist (expired, evicted, never written)
    // is an empty hash, not an error.
    if (Object.keys(fields).length === 0) return null;
    const createdAtMs = numberField(fields, "createdAt", token);
    const expiresAtMs = numberField(fields, "expiresAt", token);
    return Hold.create({
      token,
      tierId: tierId(stringField(fields, "tierId", token)),
      qty: Quantity.of(numberField(fields, "qty", token)),
      now: new Date(createdAtMs),
      ttlMs: expiresAtMs - createdAtMs,
    });
  }

  // A write against a client that is not connected would sit in ioredis's
  // offline queue until the reconnect; the request should fail now instead.
  private requireReady(operation: string): void {
    if (this.redis.status !== "ready") {
      throw new Error(`redis is ${this.redis.status}; cannot ${operation}`);
    }
  }
}

// Only create_hold.lua writes the hold hash, so a field that is missing or
// not a number is a bug, not a value — unlike the event cache, which a hand
// edit was expected to corrupt.
function stringField(fields: Record<string, string>, name: string, token: HoldToken): string {
  const value = fields[name];
  if (value === undefined) throw new Error(`hold ${token} has no ${name} field`);
  return value;
}

function numberField(fields: Record<string, string>, name: string, token: HoldToken): number {
  const value = Number(stringField(fields, name, token));
  if (!Number.isFinite(value)) throw new Error(`hold ${token} has a non-numeric ${name}`);
  return value;
}
