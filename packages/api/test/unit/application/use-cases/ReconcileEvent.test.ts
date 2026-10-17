import { describe, expect, it } from "vitest";
import type { EventRepository } from "../../../../src/application/ports/EventRepository.js";
import { ReconcileEventUseCase } from "../../../../src/application/use-cases/ReconcileEvent.js";
import { ReleaseExpiredHoldsUseCase } from "../../../../src/application/use-cases/ReleaseExpiredHolds.js";
import { holdToken } from "../../../../src/domain/value-objects/HoldToken.js";
import { eventId, tierId } from "../../../../src/domain/value-objects/Ids.js";
import { aHold, aTier, anEvent, DEFAULT_EVENT_ID } from "../../../fakes/builders.js";
import { FakeClock } from "../../../fakes/FakeClock.js";
import { InMemoryEventRepository } from "../../../fakes/InMemoryEventRepository.js";
import { InMemoryHoldRepository } from "../../../fakes/InMemoryHoldRepository.js";
import { InMemoryHoldStore } from "../../../fakes/InMemoryHoldStore.js";
import { stubHoldRepository } from "../../../fakes/stubHoldRepository.js";

const TTL_MS = 120_000;
const TIER = tierId("11111111-1111-4111-8111-aaaaaaaaaaaa");
const OTHER = tierId("11111111-1111-4111-8111-bbbbbbbbbbbb");
const START = "2026-01-01T10:00:00.000Z";

// Postgres's computed count, as the fake repository would have to compute
// it: total minus the mirror's active rows. The in-memory event repository
// holds a fixed Event, so the computation is done here, from the mirror,
// and handed to the use case through the same port.
function computing(mirror: InMemoryHoldRepository, totals: Map<string, number>): EventRepository {
  return {
    findById: async (id) => {
      if (id !== DEFAULT_EVENT_ID) return null;
      const tiers = [];
      for (const [tier, total] of totals) {
        const held = (await mirror.activeTokens(tierId(tier))).reduce(
          (sum, token) => sum + (mirror.saved(token)?.qty.value ?? 0),
          0,
        );
        tiers.push(
          aTier()
            .withId(tier)
            .withRemaining(Math.max(0, total - held))
            .build(),
        );
      }
      return anEvent().withTiers(tiers).build();
    },
    listUpcoming: async () => [],
  };
}

interface World {
  useCase: ReconcileEventUseCase;
  store: InMemoryHoldStore;
  mirror: InMemoryHoldRepository;
  clock: FakeClock;
  events: EventRepository;
}

// Two tiers of 10 and 20; a hold of 3 on TIER and of 4 on OTHER, each with
// its row. Nothing has drifted yet.
async function world(): Promise<World> {
  const clock = new FakeClock(START);
  const store = new InMemoryHoldStore(clock);
  store.seed(TIER, 10);
  store.seed(OTHER, 20);
  const mirror = new InMemoryHoldRepository();
  for (const [token, tier, qty] of [
    ["tok-a", TIER, 3],
    ["tok-b", OTHER, 4],
  ] as const) {
    const hold = aHold().forTier(tier).withToken(token).withQty(qty).createdAt(START).build();
    await store.reserve(hold);
    await mirror.save(hold);
  }
  const events = computing(
    mirror,
    new Map([
      [TIER, 10],
      [OTHER, 20],
    ]),
  );
  return {
    useCase: new ReconcileEventUseCase(events, store, mirror),
    store,
    mirror,
    clock,
    events,
  };
}

async function counts(store: InMemoryHoldStore): Promise<[number | undefined, number | undefined]> {
  const map = await store.availability([TIER, OTHER]);
  return [map.get(TIER), map.get(OTHER)];
}

describe("ReconcileEventUseCase", () => {
  it("answers unknown-event for an event that does not exist, and writes nothing", async () => {
    const { store, mirror } = await world();
    const useCase = new ReconcileEventUseCase(new InMemoryEventRepository([]), store, mirror);

    const result = await useCase.execute({
      eventId: eventId("22222222-2222-4222-8222-222222222222"),
    });

    expect(result).toEqual({ ok: false, reason: "unknown-event" });
    expect(await counts(store)).toEqual([7, 16]);
  });

  it("leaves a system that agrees with itself as it is, and reports no drift", async () => {
    const { useCase, store } = await world();

    const result = await useCase.execute({ eventId: DEFAULT_EVENT_ID });

    expect(result).toEqual({
      ok: true,
      tiers: [
        { tierId: TIER, before: 7, after: 7 },
        { tierId: OTHER, before: 16, after: 16 },
      ],
      rowsExpired: 0,
      unrecorded: [],
    });
    expect(await counts(store)).toEqual([7, 16]);
  });

  it("overwrites a counter that drifted with the computed number and reports both", async () => {
    const { useCase, store } = await world();
    await store.rebuild(TIER, 500);

    const result = await useCase.execute({ eventId: DEFAULT_EVENT_ID });

    expect(result.ok && result.tiers[0]).toEqual({ tierId: TIER, before: 500, after: 7 });
    expect(await counts(store)).toEqual([7, 16]);
  });

  it("reports a counter that did not exist as before: null, and creates it", async () => {
    const clock = new FakeClock(START);
    const store = new InMemoryHoldStore(clock);
    const mirror = new InMemoryHoldRepository();
    const useCase = new ReconcileEventUseCase(
      computing(mirror, new Map([[TIER, 10]])),
      store,
      mirror,
    );

    const result = await useCase.execute({ eventId: DEFAULT_EVENT_ID });

    expect(result.ok && result.tiers).toEqual([{ tierId: TIER, before: null, after: 10 }]);
    expect(await store.availability([TIER])).toEqual(new Map([[TIER, 10]]));
  });

  it("expires the row of a hold that is gone — no entry, no hash — and stops subtracting it", async () => {
    // The FLUSHDB shape for one hold: the store forgot it entirely.
    const clock = new FakeClock(START);
    const store = new InMemoryHoldStore(clock);
    store.seed(TIER, 10);
    const mirror = new InMemoryHoldRepository();
    await mirror.save(
      aHold().forTier(TIER).withToken("tok-lost").withQty(3).createdAt(START).build(),
    );
    const useCase = new ReconcileEventUseCase(
      computing(mirror, new Map([[TIER, 10]])),
      store,
      mirror,
    );

    const result = await useCase.execute({ eventId: DEFAULT_EVENT_ID });

    expect(result).toEqual({
      ok: true,
      tiers: [{ tierId: TIER, before: 10, after: 10 }],
      rowsExpired: 1,
      unrecorded: [],
    });
    expect(mirror.statusOf(holdToken("tok-lost"))).toBe("expired");
  });

  it("keeps the row of a hold whose index entry is gone but whose hash is alive, and still subtracts it", async () => {
    // The index key evicted on its own, or a reserve+save landing between
    // the index read and the row read: the hold is alive and reservable,
    // and expiring its row would rebuild the counter without it.
    const { useCase, store, mirror } = await world();
    store.evictIndex(TIER);

    const first = await useCase.execute({ eventId: DEFAULT_EVENT_ID });
    const second = await useCase.execute({ eventId: DEFAULT_EVENT_ID });

    expect(first.ok && first.rowsExpired).toBe(0);
    expect(mirror.statusOf(holdToken("tok-a"))).toBe("active");
    expect(first.ok && first.tiers[0]).toEqual({ tierId: TIER, before: 7, after: 7 });
    expect(second.ok && second.tiers[0]).toEqual({ tierId: TIER, before: 7, after: 7 });
  });

  it("subtracts a hold the rows never knew about, reports it, and writes no row for it", async () => {
    // ADR 0004 row 1: the save failed and the compensating release failed.
    const clock = new FakeClock(START);
    const store = new InMemoryHoldStore(clock);
    store.seed(TIER, 10);
    await store.reserve(
      aHold().forTier(TIER).withToken("tok-norow").withQty(3).createdAt(START).build(),
    );
    const rows = new InMemoryHoldRepository();
    const mirror = stubHoldRepository({
      activeTokens: rows.activeTokens.bind(rows),
      setStatus: rows.setStatus.bind(rows),
      // save stays rejecting: reconcile reads the index, it does not re-record.
    });
    const useCase = new ReconcileEventUseCase(
      computing(rows, new Map([[TIER, 10]])),
      store,
      mirror,
    );

    const result = await useCase.execute({ eventId: DEFAULT_EVENT_ID });

    expect(result).toEqual({
      ok: true,
      tiers: [{ tierId: TIER, before: 7, after: 7 }],
      rowsExpired: 0,
      unrecorded: [holdToken("tok-norow")],
    });
    expect(rows.size).toBe(0);
  });

  it("the sweeper later restores exactly what an unrecorded hold had subtracted", async () => {
    const clock = new FakeClock(START);
    const store = new InMemoryHoldStore(clock);
    store.seed(TIER, 10);
    await store.reserve(
      aHold().forTier(TIER).withToken("tok-norow").withQty(3).createdAt(START).build(),
    );
    const mirror = new InMemoryHoldRepository();
    await new ReconcileEventUseCase(
      computing(mirror, new Map([[TIER, 10]])),
      store,
      mirror,
    ).execute({
      eventId: DEFAULT_EVENT_ID,
    });
    clock.advance(TTL_MS);

    await new ReleaseExpiredHoldsUseCase(store, mirror, clock).execute();

    expect(await store.availability([TIER])).toEqual(new Map([[TIER, 10]]));
  });

  it("changes nothing for a hold whose hash is gone but whose entry and row remain", async () => {
    // Correct by doing nothing: the row keeps being subtracted, the sweeper
    // restores from the entry on expiry, and the two land on the exact number.
    const { useCase, store, mirror, clock } = await world();
    store.evictHash(holdToken("tok-a"));

    const result = await useCase.execute({ eventId: DEFAULT_EVENT_ID });
    clock.advance(TTL_MS);
    await new ReleaseExpiredHoldsUseCase(store, mirror, clock).execute();

    expect(result.ok && result.tiers[0]).toEqual({ tierId: TIER, before: 7, after: 7 });
    expect(result.ok && result.rowsExpired).toBe(0);
    expect(result.ok && result.unrecorded).toEqual([]);
    expect(await store.availability([TIER])).toEqual(new Map([[TIER, 10]]));
  });

  it("recomputes after the row repairs, not before", async () => {
    // The dead hold's row must be expired before the number is read, or the
    // counter is rebuilt short by its quantity.
    const clock = new FakeClock(START);
    const store = new InMemoryHoldStore(clock);
    store.seed(TIER, 10);
    await store.reserve(
      aHold().forTier(TIER).withToken("tok-live").withQty(2).createdAt(START).build(),
    );
    const mirror = new InMemoryHoldRepository();
    await mirror.save(
      aHold().forTier(TIER).withToken("tok-live").withQty(2).createdAt(START).build(),
    );
    await mirror.save(
      aHold().forTier(TIER).withToken("tok-lost").withQty(3).createdAt(START).build(),
    );
    const useCase = new ReconcileEventUseCase(
      computing(mirror, new Map([[TIER, 10]])),
      store,
      mirror,
    );

    const result = await useCase.execute({ eventId: DEFAULT_EVENT_ID });

    expect(result.ok && result.tiers[0]).toEqual({ tierId: TIER, before: 8, after: 8 });
  });

  it("floors the counter at zero when unrecorded holds exceed what Postgres can see", async () => {
    const clock = new FakeClock(START);
    const store = new InMemoryHoldStore(clock);
    store.seed(TIER, 10);
    await store.reserve(
      aHold().forTier(TIER).withToken("tok-big").withQty(10).createdAt(START).build(),
    );
    await store.rebuild(TIER, -5);
    const mirror = new InMemoryHoldRepository();
    // Postgres sees 10 of 10; the store holds 10 nobody recorded.
    const useCase = new ReconcileEventUseCase(
      computing(mirror, new Map([[TIER, 10]])),
      store,
      mirror,
    );

    const result = await useCase.execute({ eventId: DEFAULT_EVENT_ID });

    expect(result.ok && result.tiers[0]).toEqual({ tierId: TIER, before: -5, after: 0 });
  });

  it("throws, rather than answering unknown-event, when the event vanishes after rows were written", async () => {
    const { store, mirror } = await world();
    let reads = 0;
    const vanishing: EventRepository = {
      findById: async (id) => {
        reads += 1;
        return reads === 1
          ? await new InMemoryEventRepository([
              anEvent().withTiers([aTier().build()]).build(),
            ]).findById(id)
          : null;
      },
      listUpcoming: async () => [],
    };

    await expect(
      new ReconcileEventUseCase(vanishing, store, mirror).execute({ eventId: DEFAULT_EVENT_ID }),
    ).rejects.toThrow(/vanished/);
  });
});
