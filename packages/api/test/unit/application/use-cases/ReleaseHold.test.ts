import { describe, expect, it } from "vitest";
import { ReleaseHoldUseCase } from "../../../../src/application/use-cases/ReleaseHold.js";
import { holdToken } from "../../../../src/domain/value-objects/HoldToken.js";
import { tierId } from "../../../../src/domain/value-objects/Ids.js";
import { FakeClock } from "../../../fakes/FakeClock.js";
import { InMemoryHoldStore } from "../../../fakes/InMemoryHoldStore.js";

const TTL_MS = 120_000;
const TIER = tierId("11111111-1111-4111-8111-aaaaaaaaaaaa");
const TOKEN = holdToken("tok-1");

// A world with 10 tickets, 4 of them held under TOKEN since 10:00:00.
async function world(): Promise<{
  useCase: ReleaseHoldUseCase;
  holds: InMemoryHoldStore;
  clock: FakeClock;
}> {
  const clock = new FakeClock("2026-01-01T10:00:00.000Z");
  const holds = new InMemoryHoldStore(clock);
  holds.seed(TIER, 10);
  await holds.reserve(TIER, 4, TOKEN, TTL_MS);
  return { useCase: new ReleaseHoldUseCase(holds), holds, clock };
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
});
