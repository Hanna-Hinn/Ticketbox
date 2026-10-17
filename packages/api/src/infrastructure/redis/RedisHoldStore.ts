import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { ExpiredHold, HoldStore, SweepResult } from "../../application/ports/HoldStore.js";
import type { HeldEntry, InventoryRepair } from "../../application/ports/InventoryRepair.js";
import { Hold } from "../../domain/entities/Hold.js";
import type { HoldToken } from "../../domain/value-objects/HoldToken.js";
import { eventId, tierId, type TierId } from "../../domain/value-objects/Ids.js";
import { Quantity } from "../../domain/value-objects/Quantity.js";
import { describeRedisError } from "./client.js";
import { decodeMember, encodeMember } from "./holdIndex.js";
import { keys } from "./keys.js";
import { defineHoldScripts } from "./scripts.js";
import { CACHE_COMMAND_DEADLINE_MS, within } from "./within.js";

// The scripts' reply contracts: create_hold.lua answers INSUFFICIENT or
// NO_COUNTER, release_hold.lua answers NOTHING_TO_RELEASE or NO_COUNTER,
// sweep_hold.lua answers NOTHING_TO_SWEEP, NO_COUNTER or NOT_EXPIRED;
// anything >= 0 is the tier's new remaining.
const INSUFFICIENT = -1;
const NOTHING_TO_RELEASE = -1;
const NOTHING_TO_SWEEP = -1;
const NOTHING_TO_CONSUME = -1;
const NO_COUNTER = -2;
const NOT_EXPIRED = -3;

// SCAN's hint, not a limit: Redis returns about this many keys per call.
const SCAN_COUNT = 100;

// A socket that is "ready" and not answering (half-open TCP, a BUSY server)
// would hold a POST /holds for as long as the OS takes to notice; the write
// path gets a deadline too, wider than the cache's because a script that
// ran but whose reply was lost is not "did not happen" — it is a hold with
// nobody holding its token, bounded by the TTL (plan §6).
const HOLD_COMMAND_DEADLINE_MS = 1_000;

// The live truth about holds: a counter per tier, a hash per hold with the
// hold's own TTL, a sorted set per tier for the sweeper. Writes fail closed
// (a store that cannot be reached is an error, never "insufficient");
// reads fail open to the computed count (ADR 0002).
export class RedisHoldStore implements HoldStore, InventoryRepair {
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
    const left = await within(
      this.redis.createHold(
        keys.tier(hold.tierId),
        keys.hold(hold.token),
        keys.tierHolds(hold.tierId),
        hold.qty.value,
        hold.token,
        hold.tierId,
        hold.createdAt.getTime(),
        hold.expiresAt.getTime(),
        hold.expiresAt.getTime() - hold.createdAt.getTime(),
        hold.eventId,
      ),
      HOLD_COMMAND_DEADLINE_MS,
      "reserve",
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

  async release(
    token: HoldToken,
  ): Promise<{ released: true; tierId: TierId; remaining: number } | { released: false }> {
    this.requireReady("release");
    // The tier's keys are named after an id that lives inside the hold, so
    // one read comes first. The read and the script are not atomic, and
    // need not be: the script's own EXISTS is the compare, and a hold that
    // expires in between is answered "nothing to release".
    const tier = await within(
      this.redis.hget(keys.hold(token), "tierId"),
      HOLD_COMMAND_DEADLINE_MS,
      "release",
    );
    if (tier === null) return { released: false };
    const owner = tierId(tier);
    const left = await within(
      this.redis.releaseHold(
        keys.hold(token),
        keys.tier(owner),
        keys.tierHolds(owner),
        token,
        owner,
      ),
      HOLD_COMMAND_DEADLINE_MS,
      "release",
    );
    if (left === NO_COUNTER) {
      // Restoring into a missing counter would create one of size qty and
      // hide the tier from the computed-count fallback (ADR 0002). The hold
      // stays until its TTL; reconciliation (TB-027) brings the counter back.
      this.log.warn(
        { tierId: owner, key: keys.tier(owner) },
        "no live counter for tier; hold not released until it is reconciled",
      );
      return { released: false };
    }
    if (left === NOTHING_TO_RELEASE) return { released: false };
    return { released: true, tierId: owner, remaining: left };
  }

  async availability(tierIds: readonly TierId[]): Promise<ReadonlyMap<TierId, number>> {
    const result = new Map<TierId, number>();
    if (this.redis.status !== "ready") return result;
    let counts: (string | null)[];
    try {
      counts = await within(
        Promise.all(tierIds.map((id) => this.redis.hget(keys.tier(id), "remaining"))),
        CACHE_COMMAND_DEADLINE_MS,
        "live counts",
      );
    } catch (err: unknown) {
      this.log.warn({ err: describeRedisError(err) }, "live counts unavailable; computed counts");
      return result;
    }
    tierIds.forEach((id, i) => {
      const count = counts[i];
      if (count === null || count === undefined) return;
      const remaining = Number(count);
      // A counter that is not a number is our own write gone wrong; on the
      // read path that is "no live count" (the computed fallback, ADR 0002)
      // plus a warn, the same fail-open shape as a cache entry that does
      // not parse. reserve against it fails instead: the script's tonumber
      // yields nil and the comparison raises.
      if (!Number.isFinite(remaining)) {
        this.log.warn({ tierId: id, key: keys.tier(id), count }, "live counter is not a number");
        return;
      }
      result.set(id, remaining);
    });
    return result;
  }

  async find(token: HoldToken): Promise<Hold | null> {
    this.requireReady("find");
    const fields = await within(
      this.redis.hgetall(keys.hold(token)),
      HOLD_COMMAND_DEADLINE_MS,
      "find",
    );
    // HGETALL on a key that does not exist (expired, evicted, never written)
    // is an empty hash, not an error.
    if (Object.keys(fields).length === 0) return null;
    const createdAtMs = numberField(fields, "createdAt", token);
    const expiresAtMs = numberField(fields, "expiresAt", token);
    return Hold.create({
      token,
      eventId: eventId(stringField(fields, "eventId", token)),
      tierId: tierId(stringField(fields, "tierId", token)),
      qty: Quantity.of(numberField(fields, "qty", token)),
      now: new Date(createdAtMs),
      ttlMs: expiresAtMs - createdAtMs,
    });
  }

  async expired(now: Date): Promise<readonly ExpiredHold[]> {
    this.requireReady("list expired holds");
    // SCAN, never KEYS: KEYS walks the whole keyspace in one blocking call.
    // A scan may hand back a key twice or miss one that moved during a
    // rehash; the sweeper runs every few seconds, so a duplicate is a
    // "nothing to sweep" and a miss is next tick's.
    const found: ExpiredHold[] = [];
    let cursor = "0";
    do {
      const [next, batch] = await within(
        this.redis.scan(cursor, "MATCH", keys.tierHoldsPattern(), "COUNT", SCAN_COUNT),
        HOLD_COMMAND_DEADLINE_MS,
        "scan for expired holds",
      );
      cursor = next;
      for (const key of batch) {
        const tier = keys.tierIdOfHolds(key);
        if (tier === null) {
          // The pattern matched a key the parser does not: the two have
          // drifted, and a sweeper that finds nothing must not be silent.
          this.log.warn({ key }, "index key does not parse; skipped");
          continue;
        }
        const members = await within(
          this.redis.zrangebyscore(key, "-inf", now.getTime()),
          HOLD_COMMAND_DEADLINE_MS,
          "expired holds",
        );
        for (const member of members) {
          const decoded = decodeMember(member);
          if (decoded === null) {
            // An entry this version did not write (a hold from before the
            // member carried qty): nothing to restore from, so remove it
            // rather than retry it every tick; reconciliation (TB-027)
            // is what puts that quantity back.
            this.log.warn({ tierId: tier, member }, "unreadable index entry removed; reconcile");
            await within(this.redis.zrem(key, member), HOLD_COMMAND_DEADLINE_MS, "expired holds");
            continue;
          }
          found.push({ token: decoded.token, tierId: tier, qty: decoded.qty });
        }
      }
    } while (cursor !== "0");
    return found;
  }

  async sweep(hold: ExpiredHold, now: Date): Promise<SweepResult> {
    this.requireReady("sweep");
    const left = await within(
      this.redis.sweepHold(
        keys.tierHolds(hold.tierId),
        keys.tier(hold.tierId),
        keys.hold(hold.token),
        encodeMember(hold.token, hold.qty),
        hold.qty,
        now.getTime(),
      ),
      HOLD_COMMAND_DEADLINE_MS,
      "sweep",
    );
    if (left === NOTHING_TO_SWEEP) return { swept: false };
    if (left === NOT_EXPIRED) {
      // The script refused an alive hold. expired() never lists one, so this
      // is a caller handing the store something it did not get from
      // expired(), or a clock running ahead of the one that set the score.
      this.log.warn({ tierId: hold.tierId, token: hold.token }, "sweep refused: hold not expired");
      return { swept: false };
    }
    if (left === NO_COUNTER) {
      // Nothing to restore into; the entry is gone so this is not retried,
      // and the row is still marked expired so reconciliation's computed
      // count (ADR 0002) is right when it rebuilds this counter.
      this.log.warn(
        { tierId: hold.tierId, token: hold.token, qty: hold.qty, key: keys.tier(hold.tierId) },
        "no live counter for tier; expired hold swept without restoring; reconcile",
      );
      return { swept: true, restored: false };
    }
    return { swept: true, restored: true, remaining: left };
  }

  async consume(token: HoldToken): Promise<boolean> {
    this.requireReady("consume");
    // As release: one read for the tier the keys are named after, then the
    // script's own EXISTS is the compare. A hold that goes between the two
    // is "nothing to consume".
    const tier = await within(
      this.redis.hget(keys.hold(token), "tierId"),
      HOLD_COMMAND_DEADLINE_MS,
      "consume",
    );
    if (tier === null) return false;
    const owner = tierId(tier);
    const reply = await within(
      this.redis.consumeHold(keys.hold(token), keys.tierHolds(owner), token, owner),
      HOLD_COMMAND_DEADLINE_MS,
      "consume",
    );
    return reply !== NOTHING_TO_CONSUME;
  }

  async held(tierId: TierId): Promise<readonly HeldEntry[]> {
    this.requireReady("list held");
    const members = await within(
      this.redis.zrange(keys.tierHolds(tierId), "0", "-1"),
      HOLD_COMMAND_DEADLINE_MS,
      "held",
    );
    const entries: HeldEntry[] = [];
    for (const member of members) {
      const decoded = decodeMember(member);
      // An entry this version did not write is the sweeper's to remove on
      // its next pass; one cleaner per mess.
      if (decoded === null) continue;
      entries.push({ token: decoded.token, qty: decoded.qty });
    }
    return entries;
  }

  async rebuild(tierId: TierId, remaining: number): Promise<{ before: number | null }> {
    this.requireReady("rebuild");
    // MULTI/EXEC: the read and the overwrite run as one unit, no command
    // from anyone else between them — the non-Lua way to make two commands
    // atomic when nothing has to be decided in the middle. HSET on a key
    // with no TTL loses nothing.
    const replies = await within(
      this.redis
        .multi()
        .hget(keys.tier(tierId), "remaining")
        .hset(keys.tier(tierId), "remaining", remaining)
        .exec(),
      HOLD_COMMAND_DEADLINE_MS,
      "rebuild",
    );
    // exec() answers null only when a WATCHed key changed; nothing is
    // watched. Each reply is [error, value]; a transaction is isolated, not
    // rolled back, so the HSET's reply is checked as well as the HGET's.
    if (replies === null) throw new Error(`rebuild of ${tierId}: transaction aborted`);
    const failed = replies.find(([err]) => err !== null)?.[0];
    if (failed) throw failed;
    const previous = replies[0]?.[1];
    if (typeof previous !== "string") return { before: null };
    const before = Number(previous);
    // A counter that is not an integer is a hand edit; report it as absent
    // rather than hand the DTO a 3.5.
    return { before: Number.isInteger(before) ? before : null };
  }

  // A write against a client that is not connected would sit in ioredis's
  // offline queue until the reconnect; the request should fail now instead.
  // (A client that is connected and silent is the deadline's job, above.)
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
