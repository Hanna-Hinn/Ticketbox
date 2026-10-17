import { describe, expect, it } from "vitest";
import { holdToken } from "../../../src/domain/value-objects/HoldToken.js";
import { tierId } from "../../../src/domain/value-objects/Ids.js";
import { anEvent } from "../../fakes/builders.js";
import { FakeClock } from "../../fakes/FakeClock.js";
import { FixedTokenGenerator } from "../../fakes/FixedTokenGenerator.js";
import { InMemoryEventRepository } from "../../fakes/InMemoryEventRepository.js";
import { InMemoryHoldStore } from "../../fakes/InMemoryHoldStore.js";

// The fakes are the contract every later unit test trusts. The contract is
// the HoldStore port's, so the port's semantics are pinned here once.

const TIER = tierId("t-1");
const TOKEN = holdToken("tok-1");

describe("InMemoryHoldStore", () => {
  it("treats a tier it has never seen as insufficient and does not invent it", async () => {
    const store = new InMemoryHoldStore();

    const result = await store.reserve(TIER, 1, TOKEN);

    expect(result).toEqual({ ok: false, reason: "insufficient" });
    expect(await store.availability([TIER])).toEqual(new Map());
  });

  it("restores inventory on release exactly once", async () => {
    const store = new InMemoryHoldStore();
    store.seed(TIER, 10);
    await store.reserve(TIER, 4, TOKEN);

    const first = await store.release(TOKEN);
    const second = await store.release(TOKEN);

    expect(first).toEqual({ released: true, tierId: TIER, remaining: 10 });
    expect(second).toEqual({ released: false });
    expect(await store.availability([TIER])).toEqual(new Map([[TIER, 10]]));
  });

  it("refuses a duplicate token instead of silently overwriting the first hold", async () => {
    const store = new InMemoryHoldStore();
    store.seed(TIER, 10);
    await store.reserve(TIER, 4, TOKEN);

    await expect(store.reserve(TIER, 1, TOKEN)).rejects.toThrow(/already holds/);

    expect(await store.availability([TIER])).toEqual(new Map([[TIER, 6]]));
  });
});

describe("FixedTokenGenerator", () => {
  it("hands out its tokens in order and refuses to invent more", () => {
    const tokens = new FixedTokenGenerator(["a", "b"]);

    expect(tokens.next()).toBe("a");
    expect(tokens.next()).toBe("b");
    expect(() => tokens.next()).toThrow(/ran out/);
  });
});

describe("FakeClock", () => {
  it("advances by exactly the requested milliseconds and hands out fresh dates", () => {
    const clock = new FakeClock("2026-01-01T10:00:00.000Z");
    const before = clock.now();

    clock.advance(1500);
    before.setTime(0);

    expect(clock.now()).toEqual(new Date("2026-01-01T10:00:01.500Z"));
  });
});

describe("InMemoryEventRepository", () => {
  it("lists an event as upcoming only if it starts strictly after now", async () => {
    const startsAt = new Date("2026-12-05T19:30:00.000Z");
    const repo = new InMemoryEventRepository([anEvent().startingAt(startsAt).build()]);

    expect(await repo.listUpcoming(new Date(startsAt.getTime() - 1))).toHaveLength(1);
    expect(await repo.listUpcoming(startsAt)).toHaveLength(0);
  });
});
