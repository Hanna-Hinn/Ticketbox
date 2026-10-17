import { describe, expect, it } from "vitest";
import { ReleaseExpiredHoldsUseCase } from "../../../../src/application/use-cases/ReleaseExpiredHolds.js";
import { holdToken } from "../../../../src/domain/value-objects/HoldToken.js";
import { tierId } from "../../../../src/domain/value-objects/Ids.js";
import { aHold } from "../../../fakes/builders.js";
import { FakeClock } from "../../../fakes/FakeClock.js";
import { InMemoryHoldRepository } from "../../../fakes/InMemoryHoldRepository.js";
import { InMemoryHoldStore } from "../../../fakes/InMemoryHoldStore.js";
import { stubHoldRepository } from "../../../fakes/stubHoldRepository.js";
import { stubHoldStore } from "../../../fakes/stubHoldStore.js";

const TTL_MS = 120_000;
const TIER = tierId("11111111-1111-4111-8111-aaaaaaaaaaaa");
const OTHER = tierId("11111111-1111-4111-8111-bbbbbbbbbbbb");
const START = "2026-01-01T10:00:00.000Z";

// A world with two tiers of 10, three holds taken at 10:00:00 — two on TIER
// (3 and 2), one on OTHER (4) — and one more on TIER taken a minute later,
// so that at 10:02:00 three have expired and the late one is alive.
async function world(): Promise<{
  useCase: ReleaseExpiredHoldsUseCase;
  holds: InMemoryHoldStore;
  mirror: InMemoryHoldRepository;
  clock: FakeClock;
}> {
  const clock = new FakeClock(START);
  const holds = new InMemoryHoldStore(clock);
  holds.seed(TIER, 10);
  holds.seed(OTHER, 10);
  const mirror = new InMemoryHoldRepository();
  for (const [token, tier, qty, at] of [
    ["tok-a", TIER, 3, START],
    ["tok-b", TIER, 2, START],
    ["tok-c", OTHER, 4, START],
    ["tok-late", TIER, 1, "2026-01-01T10:01:00.000Z"],
  ] as const) {
    const hold = aHold()
      .forTier(tier)
      .withToken(token)
      .withQty(qty)
      .createdAt(at)
      .withTtl(TTL_MS)
      .build();
    await holds.reserve(hold);
    await mirror.save(hold);
  }
  return { useCase: new ReleaseExpiredHoldsUseCase(holds, mirror, clock), holds, mirror, clock };
}

describe("ReleaseExpiredHoldsUseCase", () => {
  it("restores exactly the expired holds' quantities and leaves the alive one held", async () => {
    const { useCase, holds, clock } = await world();
    clock.advance(TTL_MS);

    const result = await useCase.execute();

    expect(result).toEqual({ swept: 3, restored: 3, unmarked: [] });
    expect(await holds.availability([TIER, OTHER])).toEqual(
      new Map([
        [TIER, 9],
        [OTHER, 10],
      ]),
    );
  });

  it("sweeping twice restores once", async () => {
    const { useCase, holds, clock } = await world();
    clock.advance(TTL_MS);

    const first = await useCase.execute();
    const second = await useCase.execute();

    expect(first.restored).toBe(3);
    expect(second).toEqual({ swept: 0, restored: 0, unmarked: [] });
    expect(await holds.availability([TIER, OTHER])).toEqual(
      new Map([
        [TIER, 9],
        [OTHER, 10],
      ]),
    );
  });

  it("sweeps nothing before anything has expired", async () => {
    const { useCase, holds, clock } = await world();
    clock.advance(TTL_MS - 1);

    const result = await useCase.execute();

    expect(result).toEqual({ swept: 0, restored: 0, unmarked: [] });
    expect(await holds.availability([TIER])).toEqual(new Map([[TIER, 4]]));
  });

  it("sweeps a hold at the exact instant of its expiry", async () => {
    const { useCase, clock } = await world();
    clock.advance(TTL_MS);

    const result = await useCase.execute();

    expect(result.swept).toBe(3);
  });

  it("marks the swept rows expired and leaves the alive one active", async () => {
    const { useCase, mirror, clock } = await world();
    clock.advance(TTL_MS);

    await useCase.execute();

    expect(mirror.statusOf(holdToken("tok-a"))).toBe("expired");
    expect(mirror.statusOf(holdToken("tok-b"))).toBe("expired");
    expect(mirror.statusOf(holdToken("tok-c"))).toBe("expired");
    expect(mirror.statusOf(holdToken("tok-late"))).toBe("active");
  });

  it("sweeps a hold that has no row, and counts it", async () => {
    // ADR 0004 row 1: the save failed and the compensating release failed
    // too. The tickets still come back; the row that is not there is not
    // an error at the mirror's port.
    const clock = new FakeClock(START);
    const holds = new InMemoryHoldStore(clock);
    holds.seed(TIER, 10);
    await holds.reserve(
      aHold().forTier(TIER).withToken("tok-norow").withQty(2).createdAt(START).build(),
    );
    const mirror = new InMemoryHoldRepository();
    clock.advance(TTL_MS);

    const result = await new ReleaseExpiredHoldsUseCase(holds, mirror, clock).execute();

    expect(result).toEqual({ swept: 1, restored: 1, unmarked: [] });
    expect(await holds.availability([TIER])).toEqual(new Map([[TIER, 10]]));
    expect(mirror.size).toBe(0);
  });

  it("reports a row it could not mark, with the error, and still sweeps the others", async () => {
    // A batch: one engine's outage must not throttle the other's restores.
    const clock = new FakeClock(START);
    const holds = new InMemoryHoldStore(clock);
    holds.seed(TIER, 10);
    for (const token of ["tok-a", "tok-b"]) {
      await holds.reserve(
        aHold().forTier(TIER).withToken(token).withQty(2).createdAt(START).build(),
      );
    }
    const down = new Error("postgres is down");
    const brokenMirror = stubHoldRepository({
      setStatus: (token) =>
        token === holdToken("tok-a") ? Promise.reject(down) : Promise.resolve(),
    });
    clock.advance(TTL_MS);

    const result = await new ReleaseExpiredHoldsUseCase(holds, brokenMirror, clock).execute();

    expect(result.swept).toBe(2);
    expect(result.restored).toBe(2);
    expect(result.unmarked).toHaveLength(1);
    expect(result.unmarked[0]?.token).toBe(holdToken("tok-a"));
    expect(result.unmarked[0]?.error).toBe(down);
    expect(await holds.availability([TIER])).toEqual(new Map([[TIER, 10]]));
  });

  it("never marks a row the store did not sweep", async () => {
    // A late release won the race: the row is the release's to mark.
    const clock = new FakeClock(START);
    const store = stubHoldStore({
      expired: async () => [{ token: holdToken("tok-a"), tierId: TIER, qty: 2 }],
      sweep: async () => ({ swept: false }),
    });
    const untouchableMirror = stubHoldRepository();

    const result = await new ReleaseExpiredHoldsUseCase(store, untouchableMirror, clock).execute();

    expect(result).toEqual({ swept: 0, restored: 0, unmarked: [] });
  });

  it("counts a sweep that found no counter as swept but not restored, and still marks its row", async () => {
    // The entry is gone and reconciliation rebuilds the counter from the
    // rows, which is right only if this row says expired.
    const clock = new FakeClock(START);
    const store = stubHoldStore({
      expired: async () => [{ token: holdToken("tok-a"), tierId: TIER, qty: 2 }],
      sweep: async () => ({ swept: true, restored: false }),
    });
    const marked: string[] = [];
    const mirror = stubHoldRepository({
      setStatus: async (token, status) => {
        marked.push(`${token}:${status}`);
      },
    });

    const result = await new ReleaseExpiredHoldsUseCase(store, mirror, clock).execute();

    expect(result).toEqual({ swept: 1, restored: 0, unmarked: [] });
    expect(marked).toEqual(["tok-a:expired"]);
  });

  it("reads the clock once and hands the same instant to the listing and every sweep", async () => {
    const instants: number[] = [];
    let reads = 0;
    const clock = {
      now: (): Date => {
        reads += 1;
        return new Date(Date.UTC(2026, 0, 1, 10, 2, 0, reads));
      },
    };
    const store = stubHoldStore({
      expired: async (now) => {
        instants.push(now.getTime());
        return [
          { token: holdToken("tok-a"), tierId: TIER, qty: 1 },
          { token: holdToken("tok-b"), tierId: TIER, qty: 1 },
        ];
      },
      sweep: async (_hold, now) => {
        instants.push(now.getTime());
        return { swept: true, restored: true, remaining: 10 };
      },
    });

    await new ReleaseExpiredHoldsUseCase(store, new InMemoryHoldRepository(), clock).execute();

    expect(reads).toBe(1);
    expect(new Set(instants).size).toBe(1);
  });

  it("lets a store failure abort the pass: Redis is the engine being worked", async () => {
    const clock = new FakeClock(START);
    const store = stubHoldStore({
      expired: () => Promise.reject(new Error("redis is away")),
    });

    await expect(
      new ReleaseExpiredHoldsUseCase(store, new InMemoryHoldRepository(), clock).execute(),
    ).rejects.toThrow("redis is away");
  });
});
