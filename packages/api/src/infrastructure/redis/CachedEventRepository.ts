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

// Cache-aside in front of another EventRepository (ADR 0003): a miss reads
// through and writes the event back with a TTL; a hit never touches
// Postgres. Nothing above L3 can tell — the same port in, the same port out.
//
// Two rules keep this a cache and not a liability:
// - What comes back from Redis is untrusted input (another version of this
//   code, a hand edit, a spike). It is parsed through a schema strict enough
//   that a payload it accepts cannot fail the domain constructors; anything
//   else is a miss, logged, never a 500.
// - A dead Redis must not slow a read down. With the offline queue on
//   (TB-017), a GET issued while the client is reconnecting waits, so when
//   the client is not "ready" the cache is skipped. That guard cannot see a
//   command already on the wire when the socket dies: ioredis re-sends it
//   after the reconnect (autoResendUnfulfilledCommands, default on) and
//   rejects it only after maxRetriesPerRequest attempts, ~74 s with TB-017's
//   defaults. So every cache command also runs under a deadline, and a
//   command that fails or exceeds it is a miss. The dangling command settles
//   on its own later; nothing here waits for it.

export const CACHE_TTL_SECONDS = 300;
// A healthy local GET is ~1 ms and the fallback (Postgres, indexed) ~23 ms;
// a cache read that takes longer than the fallback has stopped being one.
export const CACHE_COMMAND_DEADLINE_MS = 100;

// The subset of ioredis the decorator uses, so a unit test can fake it with
// a Map. Structural; the real client satisfies it unchanged.
export interface CacheClient {
  readonly status: RedisStatus;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, secondsToken: "EX", seconds: number): Promise<unknown>;
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

export class CachedEventRepository implements EventRepository {
  constructor(
    private readonly inner: EventRepository,
    private readonly cache: CacheClient,
    private readonly log: Logger,
  ) {}

  async findById(id: EventId): Promise<Event | null> {
    const key = keys.eventCache(id);
    const cached = await this.read(key);
    if (cached !== null) return cached;

    const event = await this.inner.findById(id);
    // A null is not cached: negative caching is TB-019, with its own TTL.
    if (event !== null) await this.write(key, event);
    return event;
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

  private async read(key: string): Promise<Event | null> {
    if (this.cache.status !== "ready") return null;
    let raw: string | null;
    try {
      raw = await within(this.cache.get(key), CACHE_COMMAND_DEADLINE_MS);
    } catch (err: unknown) {
      this.log.warn({ err: describe(err), key }, "cache read failed; reading through");
      return null;
    }
    if (raw === null) return null;
    return this.parse(raw, key);
  }

  private async write(key: string, event: Event): Promise<void> {
    // Not "harmless to skip": an awaited SET during a reconnect would hold
    // the response until Redis returns.
    if (this.cache.status !== "ready") return;
    try {
      // Always with EX: a plain SET on an existing key clears its TTL and
      // makes it immortal (handbook §7.1).
      await within(
        this.cache.set(key, JSON.stringify(toJson(event)), "EX", CACHE_TTL_SECONDS),
        CACHE_COMMAND_DEADLINE_MS,
      );
    } catch (err: unknown) {
      this.log.warn({ err: describe(err), key }, "cache write failed; serving uncached");
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

function describe(err: unknown): ReturnType<typeof describeRedisError> {
  return err instanceof Error
    ? describeRedisError(err)
    : { name: "unknown", message: String(err), stack: undefined };
}

async function within<T>(command: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`cache command exceeded ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([command, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
