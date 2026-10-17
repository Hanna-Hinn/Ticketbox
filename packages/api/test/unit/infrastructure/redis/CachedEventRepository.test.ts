import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventRepository } from "../../../../src/application/ports/EventRepository.js";
import type { Event } from "../../../../src/domain/entities/Event.js";
import { eventId, type EventId } from "../../../../src/domain/value-objects/Ids.js";
import {
  CACHE_COMMAND_DEADLINE_MS,
  CachedEventRepository,
} from "../../../../src/infrastructure/redis/CachedEventRepository.js";
import { keys } from "../../../../src/infrastructure/redis/keys.js";
import { aTier, anEvent, DEFAULT_EVENT_ID } from "../../../fakes/builders.js";
import { InMemoryCache } from "../../../fakes/InMemoryCache.js";
import { InMemoryEventRepository } from "../../../fakes/InMemoryEventRepository.js";

// An inner repository that remembers how often it was asked: the whole point
// of the decorator is the count.
class CountingEventRepository implements EventRepository {
  calls = 0;
  constructor(private readonly inner: EventRepository) {}
  findById(id: EventId): Promise<Event | null> {
    this.calls += 1;
    return this.inner.findById(id);
  }
  listUpcoming(now: Date): Promise<readonly Event[]> {
    return this.inner.listUpcoming(now);
  }
}

const silent = pino({ level: "silent" });
const UNKNOWN = eventId("00000000-0000-4000-8000-000000000000");

function world(events: readonly Event[] = [jazz()]): {
  repo: CachedEventRepository;
  inner: CountingEventRepository;
  cache: InMemoryCache;
} {
  const inner = new CountingEventRepository(new InMemoryEventRepository(events));
  const cache = new InMemoryCache();
  return { repo: new CachedEventRepository(inner, cache, silent), inner, cache };
}

function jazz(): Event {
  return anEvent()
    .withTiers([
      aTier().withId("11111111-1111-4111-8111-aaaaaaaaaaaa").withRemaining(10).build(),
      aTier().withId("11111111-1111-4111-8111-bbbbbbbbbbbb").withRemaining(0).build(),
    ])
    .build();
}

function payload(tier: Record<string, unknown>, startsAt = "2026-12-05T19:30:00.000Z"): string {
  return JSON.stringify({
    id: DEFAULT_EVENT_ID,
    name: "n",
    venue: "v",
    startsAt,
    tiers: [
      {
        id: "t",
        eventId: DEFAULT_EVENT_ID,
        name: "G",
        priceCents: 1,
        total: 1,
        remaining: 1,
        ...tier,
      },
    ],
  });
}

describe("CachedEventRepository", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads through on a miss and serves the next read from the cache", async () => {
    const { repo, inner } = world();

    const first = await repo.findById(DEFAULT_EVENT_ID);
    const second = await repo.findById(DEFAULT_EVENT_ID);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(inner.calls).toBe(1);
  });

  it("round-trips every field of the event and its tiers", async () => {
    const { repo } = world();
    const original = await repo.findById(DEFAULT_EVENT_ID);

    const cached = await repo.findById(DEFAULT_EVENT_ID);

    expect(cached).not.toBe(original);
    expect(cached?.id).toBe(original?.id);
    expect(cached?.name).toBe(original?.name);
    expect(cached?.venue).toBe(original?.venue);
    expect(cached?.startsAt).toEqual(original?.startsAt);
    expect(
      cached?.tiers.map((t) => [t.id, t.eventId, t.name, t.price.cents, t.total, t.remaining]),
    ).toEqual(
      original?.tiers.map((t) => [t.id, t.eventId, t.name, t.price.cents, t.total, t.remaining]),
    );
  });

  it("writes with the 300 s TTL", async () => {
    const { repo, cache } = world();

    await repo.findById(DEFAULT_EVENT_ID);

    expect(cache.entries.get(keys.eventCache(DEFAULT_EVENT_ID))?.ttlSeconds).toBe(300);
  });

  it.each([
    ["not JSON", "{"],
    ["the wrong shape", JSON.stringify({ id: "x" })],
    [
      "remaining above total",
      JSON.stringify({
        id: DEFAULT_EVENT_ID,
        name: "n",
        venue: "v",
        startsAt: "2026-12-05T19:30:00.000Z",
        tiers: [
          { id: "t", eventId: DEFAULT_EVENT_ID, name: "G", priceCents: 1, total: 1, remaining: 2 },
        ],
      }),
    ],
    [
      "a tier of another event",
      JSON.stringify({
        id: DEFAULT_EVENT_ID,
        name: "n",
        venue: "v",
        startsAt: "2026-12-05T19:30:00.000Z",
        tiers: [{ id: "t", eventId: UNKNOWN, name: "G", priceCents: 1, total: 1, remaining: 1 }],
      }),
    ],
    // Schema-shaped but constructor-hostile: these are what keep the "cannot
    // throw here" comment in fromJson true.
    ["an unsafe integer price", payload({ priceCents: 2 ** 53 })],
    ["a fractional remaining", payload({ remaining: 1.5 })],
    ["a negative fractional total", payload({ total: -0.5 })],
    ["a calendar-impossible date", payload({}, "2026-02-30T00:00:00Z")],
    ["a date with an offset", payload({}, "2026-12-05T19:30:00+01:00")],
  ])("treats a cached value that is %s as a miss and heals it", async (_what, raw) => {
    const { repo, inner, cache } = world();
    cache.entries.set(keys.eventCache(DEFAULT_EVENT_ID), { value: raw, ttlSeconds: 300 });

    const event = await repo.findById(DEFAULT_EVENT_ID);

    expect(event?.name).toBe("Rooftop Jazz Night");
    expect(inner.calls).toBe(1);
    expect(cache.entries.get(keys.eventCache(DEFAULT_EVENT_ID))?.value).not.toBe(raw);
  });

  it("does not cache an unknown event", async () => {
    const { repo, inner, cache } = world();

    expect(await repo.findById(UNKNOWN)).toBeNull();
    expect(await repo.findById(UNKNOWN)).toBeNull();

    expect(inner.calls).toBe(2);
    expect(cache.entries.size).toBe(0);
  });

  it("skips the cache entirely while the client is not ready", async () => {
    const { repo, inner, cache } = world();
    cache.status = "reconnecting";

    await repo.findById(DEFAULT_EVENT_ID);
    await repo.findById(DEFAULT_EVENT_ID);

    expect(inner.calls).toBe(2);
    expect(cache.entries.size).toBe(0);
  });

  it("reads through when a cache command throws", async () => {
    const { repo, inner, cache } = world();
    cache.failing = true;

    const event = await repo.findById(DEFAULT_EVENT_ID);

    expect(event?.name).toBe("Rooftop Jazz Night");
    expect(inner.calls).toBe(1);
  });

  it("reads through when a cache read never settles, within the deadline", async () => {
    vi.useFakeTimers();
    const { repo, inner, cache } = world();
    cache.hanging = true;

    const pending = repo.findById(DEFAULT_EVENT_ID);
    // One deadline for the read that never answers, one for the write-back
    // that never answers either; the caller gets its event after both.
    await vi.advanceTimersByTimeAsync(CACHE_COMMAND_DEADLINE_MS);
    await vi.advanceTimersByTimeAsync(CACHE_COMMAND_DEADLINE_MS);

    expect((await pending)?.name).toBe("Rooftop Jazz Night");
    expect(inner.calls).toBe(1);
  });

  it("returns the event when the cache write never settles, within the deadline", async () => {
    vi.useFakeTimers();
    const { repo, cache } = world();
    const client = cache;
    const originalGet = client.get.bind(client);
    // The read misses normally; only the write hangs.
    client.get = async (key: string): Promise<string | null> => {
      const value = await originalGet(key);
      client.hanging = true;
      return value;
    };

    const pending = repo.findById(DEFAULT_EVENT_ID);
    await vi.advanceTimersByTimeAsync(CACHE_COMMAND_DEADLINE_MS);

    expect((await pending)?.name).toBe("Rooftop Jazz Night");
  });

  it("refuses to invalidate while the client is not ready, instead of hanging", async () => {
    const { repo, cache } = world();
    cache.status = "reconnecting";

    await expect(repo.invalidate(DEFAULT_EVENT_ID)).rejects.toThrow(/reconnecting/);
  });

  it("fails an invalidation that never settles, at the deadline", async () => {
    vi.useFakeTimers();
    const { repo, cache } = world();
    cache.hanging = true;

    const pending = repo.invalidate(DEFAULT_EVENT_ID);
    const outcome = expect(pending).rejects.toThrow(/exceeded/);
    await vi.advanceTimersByTimeAsync(CACHE_COMMAND_DEADLINE_MS);

    await outcome;
  });

  it("returns null for an unknown event even when a corrupt key is present, and does not rewrite it", async () => {
    const { repo, cache } = world();
    cache.entries.set(keys.eventCache(UNKNOWN), { value: "{", ttlSeconds: 300 });

    const event = await repo.findById(UNKNOWN);

    expect(event).toBeNull();
    expect(cache.entries.get(keys.eventCache(UNKNOWN))?.value).toBe("{");
  });

  it("passes listUpcoming through untouched", async () => {
    const { repo, cache } = world();

    const upcoming = await repo.listUpcoming(new Date("2026-01-01T00:00:00.000Z"));

    expect(upcoming).toHaveLength(1);
    expect(cache.entries.size).toBe(0);
  });

  it("reads through again after invalidation", async () => {
    const { repo, inner } = world();
    await repo.findById(DEFAULT_EVENT_ID);

    await repo.invalidate(DEFAULT_EVENT_ID);
    await repo.findById(DEFAULT_EVENT_ID);

    expect(inner.calls).toBe(2);
  });
});
