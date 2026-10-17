import { describe, expect, it } from "vitest";
import { CreateHoldUseCase } from "../../../../src/application/use-cases/CreateHold.js";
import { InvalidHold } from "../../../../src/domain/errors/InvalidHold.js";
import { InvalidQuantity } from "../../../../src/domain/errors/InvalidQuantity.js";
import { holdToken } from "../../../../src/domain/value-objects/HoldToken.js";
import { eventId, tierId } from "../../../../src/domain/value-objects/Ids.js";
import { aTier, anEvent, DEFAULT_EVENT_ID } from "../../../fakes/builders.js";
import { FakeClock } from "../../../fakes/FakeClock.js";
import { FixedTokenGenerator } from "../../../fakes/FixedTokenGenerator.js";
import { InMemoryEventRepository } from "../../../fakes/InMemoryEventRepository.js";
import { InMemoryHoldStore } from "../../../fakes/InMemoryHoldStore.js";

const TTL_MS = 120_000;
const TIER = tierId("11111111-1111-4111-8111-aaaaaaaaaaaa");

// Every test builds its own world: a tier with 10 left, both in the
// repository (the computed count) and in the store (the live count).
function world(opts: { remaining?: number; ttlMs?: number; clock?: FakeClock } = {}) {
  const remaining = opts.remaining ?? 10;
  const clock = opts.clock ?? new FakeClock("2026-01-01T10:00:00.000Z");
  const events = new InMemoryEventRepository([
    anEvent()
      .withTiers([aTier().withRemaining(remaining).build()])
      .build(),
  ]);
  const holds = new InMemoryHoldStore();
  holds.seed(TIER, remaining);
  const tokens = new FixedTokenGenerator(["tok-1", "tok-2", "tok-3"]);
  const useCase = new CreateHoldUseCase(events, holds, clock, tokens, opts.ttlMs ?? TTL_MS);
  return { useCase, holds, clock };
}

const request = { eventId: DEFAULT_EVENT_ID, tierId: TIER, qty: 2 };

describe("CreateHoldUseCase", () => {
  it("creates a hold when inventory allows", async () => {
    const { useCase } = world({ remaining: 10 });

    const result = await useCase.execute(request);

    expect(result).toEqual({
      ok: true,
      token: holdToken("tok-1"),
      expiresAt: new Date("2026-01-01T10:02:00.000Z"),
      remaining: 8,
    });
  });

  it("sets the expiry to exactly now + ttl from the injected clock", async () => {
    const clock = new FakeClock("2026-06-30T23:59:59.999Z");
    const { useCase } = world({ clock, ttlMs: 50 });

    const result = await useCase.execute(request);

    expect(result.ok && result.expiresAt.getTime()).toBe(clock.now().getTime() + 50);
  });

  it("rejects a hold larger than remaining inventory and leaves it untouched", async () => {
    const { useCase, holds } = world({ remaining: 1 });

    const result = await useCase.execute({ ...request, qty: 2 });

    expect(result).toEqual({ ok: false, reason: "insufficient" });
    expect(await holds.availability([TIER])).toEqual(new Map([[TIER, 1]]));
  });

  it("allows a hold for exactly the remaining inventory, leaving zero", async () => {
    const { useCase } = world({ remaining: 2 });

    const result = await useCase.execute({ ...request, qty: 2 });

    expect(result).toEqual(expect.objectContaining({ ok: true, remaining: 0 }));
  });

  it("rejects a nonexistent event", async () => {
    const { useCase } = world();

    const result = await useCase.execute({ ...request, eventId: eventId("no-such-event") });

    expect(result).toEqual({ ok: false, reason: "unknown-event" });
  });

  it("rejects a tier that is not on the event", async () => {
    const { useCase } = world();

    const result = await useCase.execute({ ...request, tierId: tierId("no-such-tier") });

    expect(result).toEqual({ ok: false, reason: "unknown-tier" });
  });

  it("reduces availability by both quantities across two sequential holds", async () => {
    const { useCase, holds } = world({ remaining: 10 });

    const first = await useCase.execute({ ...request, qty: 2 });
    const second = await useCase.execute({ ...request, qty: 3 });

    expect(first).toEqual(expect.objectContaining({ ok: true, remaining: 8 }));
    expect(second).toEqual(
      expect.objectContaining({ ok: true, token: holdToken("tok-2"), remaining: 5 }),
    );
    expect(await holds.availability([TIER])).toEqual(new Map([[TIER, 5]]));
  });

  it.each([0, 11])("rejects a quantity of %i before touching anything", async (qty) => {
    const { useCase, holds } = world();

    await expect(useCase.execute({ ...request, qty })).rejects.toThrow(InvalidQuantity);

    expect(await holds.availability([TIER])).toEqual(new Map([[TIER, 10]]));
  });

  it("rejects a misconfigured ttl without reserving anything", async () => {
    const { useCase, holds } = world({ ttlMs: 0 });

    await expect(useCase.execute(request)).rejects.toThrow(InvalidHold);

    expect(await holds.availability([TIER])).toEqual(new Map([[TIER, 10]]));
    expect(await holds.release(holdToken("tok-1"))).toEqual({ released: false });
  });

  it("rejects an unreadable clock without reserving anything", async () => {
    const { useCase, holds } = world({ clock: new FakeClock("not a date") });

    await expect(useCase.execute(request)).rejects.toThrow(InvalidHold);

    expect(await holds.availability([TIER])).toEqual(new Map([[TIER, 10]]));
  });
});
