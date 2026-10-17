import { describe, expect, it } from "vitest";
import { CreateHoldUseCase } from "../../../../src/application/use-cases/CreateHold.js";
import { GetHoldUseCase } from "../../../../src/application/use-cases/GetHold.js";
import { ReleaseHoldUseCase } from "../../../../src/application/use-cases/ReleaseHold.js";
import { holdToken } from "../../../../src/domain/value-objects/HoldToken.js";
import { tierId } from "../../../../src/domain/value-objects/Ids.js";
import { aTier, anEvent, DEFAULT_EVENT_ID } from "../../../fakes/builders.js";
import { FakeClock } from "../../../fakes/FakeClock.js";
import { FixedTokenGenerator } from "../../../fakes/FixedTokenGenerator.js";
import { InMemoryEventRepository } from "../../../fakes/InMemoryEventRepository.js";
import { InMemoryHoldStore } from "../../../fakes/InMemoryHoldStore.js";

const TTL_MS = 120_000;
const TIER = tierId("11111111-1111-4111-8111-aaaaaaaaaaaa");

// The Acceptance line: the whole lifecycle, through the use cases only, with
// nothing underneath them but the fakes.
describe("a hold's lifecycle", () => {
  it("is created, counts down, is released once, and is then gone", async () => {
    const clock = new FakeClock("2026-01-01T10:00:00.000Z");
    const events = new InMemoryEventRepository([
      anEvent()
        .withTiers([aTier().withRemaining(10).build()])
        .build(),
    ]);
    const holds = new InMemoryHoldStore(clock);
    holds.seed(TIER, 10);
    const create = new CreateHoldUseCase(
      events,
      holds,
      clock,
      new FixedTokenGenerator(["tok-1"]),
      TTL_MS,
    );
    const get = new GetHoldUseCase(holds, clock);
    const release = new ReleaseHoldUseCase(holds);

    const created = await create.execute({ eventId: DEFAULT_EVENT_ID, tierId: TIER, qty: 3 });
    const fresh = await get.execute({ token: holdToken("tok-1") });
    clock.advance(30_000);
    const later = await get.execute({ token: holdToken("tok-1") });
    const released = await release.execute({ token: holdToken("tok-1") });
    const afterwards = await get.execute({ token: holdToken("tok-1") });
    const again = await release.execute({ token: holdToken("tok-1") });

    expect(created).toEqual(
      expect.objectContaining({ ok: true, token: holdToken("tok-1"), remaining: 7 }),
    );
    expect(fresh).toEqual(expect.objectContaining({ ok: true, qty: 3, remainingMs: TTL_MS }));
    expect(later).toEqual(expect.objectContaining({ ok: true, remainingMs: TTL_MS - 30_000 }));
    expect(released).toEqual({ released: true, tierId: TIER, remaining: 10 });
    expect(afterwards).toEqual({ ok: false, reason: "not-found" });
    expect(again).toEqual({ released: false });
    expect(await holds.availability([TIER])).toEqual(new Map([[TIER, 10]]));
  });

  it("left alone, expires: gone to the client, but its tickets are not back until swept", async () => {
    const clock = new FakeClock("2026-01-01T10:00:00.000Z");
    const events = new InMemoryEventRepository([
      anEvent()
        .withTiers([aTier().withRemaining(10).build()])
        .build(),
    ]);
    const holds = new InMemoryHoldStore(clock);
    holds.seed(TIER, 10);
    const create = new CreateHoldUseCase(
      events,
      holds,
      clock,
      new FixedTokenGenerator(["tok-1"]),
      TTL_MS,
    );
    const get = new GetHoldUseCase(holds, clock);

    await create.execute({ eventId: DEFAULT_EVENT_ID, tierId: TIER, qty: 3 });
    clock.advance(TTL_MS);

    expect(await get.execute({ token: holdToken("tok-1") })).toEqual({
      ok: false,
      reason: "not-found",
    });
    expect(await holds.availability([TIER])).toEqual(new Map([[TIER, 7]]));
  });
});
