import type { RedisStatus } from "ioredis";
import type { Logger } from "pino";
import { z } from "zod";
import type { EventRepository } from "../../application/ports/EventRepository.js";
import { Event } from "../../domain/entities/Event.js";
import { TicketTier } from "../../domain/entities/TicketTier.js";
import { eventId, tierId, type EventId } from "../../domain/value-objects/Ids.js";
import { Money } from "../../domain/value-objects/Money.js";
import { describeRedisError } from "./client.js";
import { keys } from "./keys.js";
import { CACHE_COMMAND_DEADLINE_MS, within } from "./within.js";

export { CACHE_COMMAND_DEADLINE_MS };

// Cache-aside in front of another EventRepository (ADR 0003): a miss reads
// through and writes the event back with a TTL; a hit never touches
// Postgres. Nothing above L3 can tell — the same port in, the same port out.
//
// Three rules keep this a cache and not a liability:
// - What comes back from Redis is untrusted input (another version of this
//   code, a hand edit, a spike). It is parsed through a schema strict enough
//   that a payload it accepts cannot fail the domain constructors; anything
//   else is a miss, logged, never a 500.
// - A dead Redis must not slow a read down. With the offline queue on
//   (TB-017), a GET issued while the client is reconnecting waits, so when
//   the client is not "ready" the cache is skipped. That guard cannot see a
//   command already on the wire when the socket dies (see within.ts), so
//   every cache command also runs under a deadline, and a command that
//   fails or exceeds it is a miss.
// - A cold key under load is one Postgres read, not fifty (TB-019): the
//   first miss wins a short NX mutex and refreshes; the others poll the key
//   and take its answer. "Not found" is cached too, briefly, so an unknown
//   id is not a Postgres read every time.

export const CACHE_TTL_SECONDS = 300;
export const NEGATIVE_TTL_SECONDS = 30;
// How long a refresh may take before the mutex expires, and how long a
// loser waits for the winner's answer before reading through itself.
export const REFRESH_MUTEX_MS = 1_000;
export const REFRESH_POLL_MS = 10;
// The JSON literal `null`: the schema can never accept it as an event, so
// it cannot be confused with one.
export const NEGATIVE_SENTINEL = "null";

// What the decorator tells about every lookup: declared by the consumer, like
// CacheClient, so the Redis-backed recorder and a test fake both satisfy it.
export interface CacheStatsRecorder {
  recordHit(): void;
  recordMiss(): void;
}

// The subset of ioredis the decorator uses, so a unit test can fake it with
// a Map. Structural; the real client satisfies it unchanged.
export interface CacheClient {
  readonly status: RedisStatus;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, secondsToken: "EX", seconds: number): Promise<unknown>;
  set(
    key: string,
    value: string,
    millisecondsToken: "PX",
    milliseconds: number,
    nx: "NX",
  ): Promise<"OK" | null>;
  del(key: string): Promise<unknown>;
}

const CachedTier = z
  .object({
    id: z.string(),
    eventId: z.string(),
    name: z.string(),
    priceCents: z.int().nonnegative(),
    total: z.int().nonnegative(),
    remaining: z.int().nonnegative(),
  })
  .refine((tier) => tier.remaining <= tier.total, { message: "remaining exceeds total" });

const CachedEvent = z
  .object({
    id: z.string(),
    name: z.string(),
    venue: z.string(),
    startsAt: z.iso.datetime(),
    tiers: z.array(CachedTier),
  })
  .refine((event) => event.tiers.every((tier) => tier.eventId === event.id), {
    message: "a tier belongs to another event",
  });

type CachedEventJson = z.infer<typeof CachedEvent>;

// What one GET told us: an answer (an event, or a cached "not found"), no
// entry, or a cache that could not be asked.
type Lookup = { kind: "hit"; event: Event | null } | { kind: "miss" } | { kind: "unavailable" };

export class CachedEventRepository implements EventRepository {
  constructor(
    private readonly inner: EventRepository,
    private readonly cache: CacheClient,
    private readonly stats: CacheStatsRecorder,
    private readonly log: Logger,
  ) {}

  async findById(id: EventId): Promise<Event | null> {
    if (this.cache.status !== "ready") return this.inner.findById(id);
    const key = keys.eventCache(id);

    const first = await this.lookup(key);
    if (first.kind === "hit") {
      this.stats.recordHit();
      return first.event;
    }
    this.stats.recordMiss();
    if (first.kind === "unavailable") return this.inner.findById(id);

    switch (await this.tryToWinRefresh(id)) {
      case "won": {
        const event = await this.inner.findById(id);
        await this.write(key, event);
        return event;
      }
      case "lost": {
        const answer = await this.waitForRefresh(key);
        if (answer.kind === "hit") return answer.event;
        // The winner died or the cache went away: read through, cache
        // nothing — the winner's SET may still land.
        return this.inner.findById(id);
      }
      case "unavailable":
        return this.inner.findById(id);
    }
  }

  // A query over time: its answer changes with the clock, so it is not
  // cached under one key. Pass-through.
  listUpcoming(now: Date): Promise<readonly Event[]> {
    return this.inner.listUpcoming(now);
  }

  // The "explicit DEL on writes". Nothing writes events yet; the method is
  // here for the writer that will, and for the tests that prove it. Unlike a
  // read, an invalidation that cannot happen must not be swallowed — that
  // would serve the old row for another 300 s — but it must not hang
  // either: not ready, or past the deadline, is a thrown error (ADR 0003).
  async invalidate(id: EventId): Promise<void> {
    if (this.cache.status !== "ready") {
      throw new Error(`cache invalidation failed: client is ${this.cache.status}`);
    }
    await within(this.cache.del(keys.eventCache(id)), CACHE_COMMAND_DEADLINE_MS);
  }

  private async lookup(key: string): Promise<Lookup> {
    let raw: string | null;
    try {
      raw = await within(this.cache.get(key), CACHE_COMMAND_DEADLINE_MS);
    } catch (err: unknown) {
      this.log.warn({ err: describeRedisError(err), key }, "cache read failed; reading through");
      return { kind: "unavailable" };
    }
    if (raw === null) return { kind: "miss" };
    if (raw === NEGATIVE_SENTINEL) return { kind: "hit", event: null };
    const event = this.parse(raw, key);
    return event === null ? { kind: "miss" } : { kind: "hit", event };
  }

  // SET NX PX: exactly one concurrent miss gets "OK". The mutex is never
  // released — it expires. Compare-and-delete (a DEL can release someone
  // else's lock) is TB-031's lesson; until then a caller that finds the key
  // missing within REFRESH_MUTEX_MS of a refresh polls instead of winning.
  private async tryToWinRefresh(id: EventId): Promise<"won" | "lost" | "unavailable"> {
    try {
      const reply = await within(
        this.cache.set(keys.eventRefresh(id), "1", "PX", REFRESH_MUTEX_MS, "NX"),
        CACHE_COMMAND_DEADLINE_MS,
      );
      return reply === "OK" ? "won" : "lost";
    } catch (err: unknown) {
      this.log.warn(
        { err: describeRedisError(err), key: keys.eventRefresh(id) },
        "refresh mutex unavailable; reading through",
      );
      return "unavailable";
    }
  }

  // A loser polls the cache key, not the mutex: the winner's SET is what it
  // is waiting for. The budget is the mutex's lifetime, so a dead winner
  // costs at most that before the loser reads through itself.
  // Look first, then sleep: the common race is the winner writing between
  // the loser's first GET and its SET NX, and that answer is already there.
  private async waitForRefresh(key: string): Promise<Lookup> {
    const deadline = Date.now() + REFRESH_MUTEX_MS;
    while (Date.now() < deadline) {
      const answer = await this.lookup(key);
      if (answer.kind !== "miss") return answer;
      await new Promise((resolve) => setTimeout(resolve, REFRESH_POLL_MS));
    }
    return { kind: "miss" };
  }

  private async write(key: string, event: Event | null): Promise<void> {
    // Not "harmless to skip": an awaited SET during a reconnect would hold
    // the response until Redis returns.
    if (this.cache.status !== "ready") return;
    const value = event === null ? NEGATIVE_SENTINEL : JSON.stringify(toJson(event));
    const ttl = event === null ? NEGATIVE_TTL_SECONDS : CACHE_TTL_SECONDS;
    try {
      // Always with EX: a plain SET on an existing key clears its TTL and
      // makes it immortal (handbook §7.1).
      await within(this.cache.set(key, value, "EX", ttl), CACHE_COMMAND_DEADLINE_MS);
    } catch (err: unknown) {
      this.log.warn({ err: describeRedisError(err), key }, "cache write failed; serving uncached");
    }
  }

  private parse(raw: string, key: string): Event | null {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.log.warn({ key }, "cached value is not JSON; treating as a miss");
      return null;
    }
    const result = CachedEvent.safeParse(json);
    if (!result.success) {
      // The issue paths, never the payload: it is untrusted and could be anything.
      const issues = result.error.issues.map((issue) => issue.path.join(".") || "(root)");
      this.log.warn({ key, issues }, "cached value failed validation; treating as a miss");
      return null;
    }
    return fromJson(result.data);
  }
}

function toJson(event: Event): CachedEventJson {
  return {
    id: event.id,
    name: event.name,
    venue: event.venue,
    startsAt: event.startsAt.toISOString(),
    tiers: event.tiers.map((tier) => ({
      id: tier.id,
      eventId: tier.eventId,
      name: tier.name,
      priceCents: tier.price.cents,
      total: tier.total,
      remaining: tier.remaining,
    })),
  };
}

// The schema already enforced every invariant these constructors check, so
// they cannot throw here; they are the only way to build the entities.
function fromJson(json: CachedEventJson): Event {
  const id = eventId(json.id);
  return Event.create({
    id,
    name: json.name,
    venue: json.venue,
    startsAt: new Date(json.startsAt),
    tiers: json.tiers.map((tier) =>
      TicketTier.create({
        id: tierId(tier.id),
        eventId: id,
        name: tier.name,
        price: Money.fromCents(tier.priceCents),
        total: tier.total,
        remaining: tier.remaining,
      }),
    ),
  });
}
