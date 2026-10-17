import { describe, expect, it } from "vitest";
import { ReleaseHoldUseCase } from "../../../../src/application/use-cases/ReleaseHold.js";
import { holdToken } from "../../../../src/domain/value-objects/HoldToken.js";
import { tierId } from "../../../../src/domain/value-objects/Ids.js";
import { aHold } from "../../../fakes/builders.js";
import { FakeClock } from "../../../fakes/FakeClock.js";
import { InMemoryHoldRepository } from "../../../fakes/InMemoryHoldRepository.js";
import { InMemoryHoldStore } from "../../../fakes/InMemoryHoldStore.js";
import { stubHoldStore } from "../../../fakes/stubHoldStore.js";

const TTL_MS = 120_000;
const TIER = tierId("11111111-1111-4111-8111-aaaaaaaaaaaa");
const TOKEN = holdToken("tok-1");

// A world with 10 tickets, 4 of them held under TOKEN since 10:00:00.
async function world(): Promise<{
  useCase: ReleaseHoldUseCase;
  holds: InMemoryHoldStore;
  mirror: InMemoryHoldRepository;
  clock: FakeClock;
}> {
  const clock = new FakeClock("2026-01-01T10:00:00.000Z");
  const holds = new InMemoryHoldStore(clock);
  holds.seed(TIER, 10);
  const hold = aHold()
    .forTier(TIER)
    .withToken(TOKEN)
    .withQty(4)
    .createdAt(clock.now())
    .withTtl(TTL_MS)
    .build();
  await holds.reserve(hold);
  const mirror = new InMemoryHoldRepository();
  await mirror.save(hold);
  return { useCase: new ReleaseHoldUseCase(holds, mirror), holds, mirror, clock };
}

describe("ReleaseHoldUseCase", () => {
  it("restores exactly the held quantity and reports the new count", async () => {
    const { useCase, holds } = await world();

    const result = await useCase.execute({ token: TOKEN });

    expect(result).toEqual({ released: true, tierId: TIER, remaining: 10 });
    expect(await holds.availability([TIER])).toEqual(new Map([[TIER, 10]]));
  });

  it("releasing twice restores only once", async () => {
    const { useCase, holds } = await world();

    const first = await useCase.execute({ token: TOKEN });
    const second = await useCase.execute({ token: TOKEN });

    expect(first).toEqual(expect.objectContaining({ released: true, remaining: 10 }));
    expect(second).toEqual({ released: false });
    expect(await holds.availability([TIER])).toEqual(new Map([[TIER, 10]]));
  });

  it("treats a token it has never seen as nothing to release", async () => {
    const { useCase, holds } = await world();

    const result = await useCase.execute({ token: holdToken("tok-nobody") });

    expect(result).toEqual({ released: false });
    expect(await holds.availability([TIER])).toEqual(new Map([[TIER, 6]]));
  });

  it("cannot release an expired hold, and does not give its inventory back either", async () => {
    // Expiry is not a release. The hold is gone, its tickets are still
    // counted as held, and only the sweeper (TB-026) puts them back.
    const { useCase, holds, clock } = await world();

    clock.advance(TTL_MS);
    const result = await useCase.execute({ token: TOKEN });

    expect(result).toEqual({ released: false });
    expect(await holds.availability([TIER])).toEqual(new Map([[TIER, 6]]));
  });

  it("can still release one ms before the expiry instant", async () => {
    const { useCase, clock } = await world();

    clock.advance(TTL_MS - 1);
    const result = await useCase.execute({ token: TOKEN });

    expect(result).toEqual({ released: true, tierId: TIER, remaining: 10 });
  });

  it("releases with a single store call and no lookup first", async () => {
    // A find followed by a release is two commands with a gap; the store's
    // compare-and-restore is the one place the decision may be made. A store
    // that rejects every read proves the use case never asks for one.
    const store = stubHoldStore({
      release: async () => ({ released: true, tierId: TIER, remaining: 10 }),
    });

    const result = await new ReleaseHoldUseCase(store, new InMemoryHoldRepository()).execute({
      token: TOKEN,
    });

    expect(result).toEqual({ released: true, tierId: TIER, remaining: 10 });
  });

  it("marks the row released once the store has released, and not before", async () => {
    const { useCase, mirror } = await world();

    await useCase.execute({ token: TOKEN });

    expect(mirror.statusOf(TOKEN)).toBe("released");
  });

  it("reports a row that could not be marked, with the tickets already back", async () => {
    // The truth moved before the record failed: the caller gets the error,
    // and a retry answers released: false (ADR 0004).
    const clock = new FakeClock("2026-01-01T10:00:00.000Z");
    const holds = new InMemoryHoldStore(clock);
    holds.seed(TIER, 10);
    await holds.reserve(
      aHold().forTier(TIER).withToken(TOKEN).withQty(4).createdAt(clock.now()).build(),
    );
    const brokenMirror = {
      save: () => Promise.reject(new Error("postgres is down")),
      setStatus: () => Promise.reject(new Error("postgres is down")),
    };

    await expect(
      new ReleaseHoldUseCase(holds, brokenMirror).execute({ token: TOKEN }),
    ).rejects.toThrow("postgres is down");

    expect(await holds.availability([TIER])).toEqual(new Map([[TIER, 10]]));
  });

  it("never touches the row when the store had nothing to release, even an unreachable one", async () => {
    const store = stubHoldStore({ release: async () => ({ released: false }) });
    const unreachableMirror = {
      save: () => Promise.reject(new Error("must not be called")),
      setStatus: () => Promise.reject(new Error("must not be called")),
    };

    const result = await new ReleaseHoldUseCase(store, unreachableMirror).execute({
      token: TOKEN,
    });

    expect(result).toEqual({ released: false });
  });

  it("leaves the row alone when there was nothing to release", async () => {
    const { useCase, mirror, clock } = await world();

    clock.advance(TTL_MS);
    await useCase.execute({ token: TOKEN });
    await useCase.execute({ token: holdToken("tok-nobody") });

    expect(mirror.statusOf(TOKEN)).toBe("active");
  });
});
