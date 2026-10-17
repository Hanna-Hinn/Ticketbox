import { describe, expect, it } from "vitest";
import type { Hold } from "../../../src/domain/entities/Hold.js";
import { holdToken } from "../../../src/domain/value-objects/HoldToken.js";
import { tierId } from "../../../src/domain/value-objects/Ids.js";
import { aHold, anEvent } from "../../fakes/builders.js";
import { FakeClock } from "../../fakes/FakeClock.js";
import { FixedTokenGenerator } from "../../fakes/FixedTokenGenerator.js";
import { InMemoryEventRepository } from "../../fakes/InMemoryEventRepository.js";
import { InMemoryHoldStore } from "../../fakes/InMemoryHoldStore.js";

// The fakes are the contract every later unit test trusts. The contract is
// the HoldStore port's, so the port's semantics are pinned here once.

const TIER = tierId("t-1");
const TOKEN = holdToken("tok-1");
const TTL_MS = 120_000;
const START = "2026-01-01T10:00:00.000Z";

function held(qty: number): Hold {
  return aHold()
    .forTier(TIER)
    .withToken(TOKEN)
    .withQty(qty)
    .createdAt(START)
    .withTtl(TTL_MS)
    .build();
}

function storeAt(start: string): { store: InMemoryHoldStore; clock: FakeClock } {
  const clock = new FakeClock(start);
  return { store: new InMemoryHoldStore(clock), clock };
}

describe("InMemoryHoldStore", () => {
  it("treats a tier it has never seen as insufficient and does not invent it", async () => {
    const { store } = storeAt(START);

    const result = await store.reserve(held(1));

    expect(result).toEqual({ ok: false, reason: "insufficient" });
    expect(await store.availability([TIER])).toEqual(new Map());
  });

  it("restores inventory on release exactly once", async () => {
    const { store } = storeAt(START);
    store.seed(TIER, 10);
    await store.reserve(held(4));

    const first = await store.release(TOKEN);
    const second = await store.release(TOKEN);

    expect(first).toEqual({ released: true, tierId: TIER, remaining: 10 });
    expect(second).toEqual({ released: false });
    expect(await store.availability([TIER])).toEqual(new Map([[TIER, 10]]));
  });

  it("refuses a duplicate token instead of silently overwriting the first hold", async () => {
    const { store } = storeAt(START);
    store.seed(TIER, 10);
    await store.reserve(held(4));

    await expect(store.reserve(held(1))).rejects.toThrow(/already holds/);

    expect(await store.availability([TIER])).toEqual(new Map([[TIER, 6]]));
  });

  it("finds a live hold by its token", async () => {
    const { store } = storeAt(START);
    store.seed(TIER, 10);
    await store.reserve(held(4));

    const hold = await store.find(TOKEN);

    expect(hold?.qty.value).toBe(4);
    expect(hold?.expiresAt).toEqual(new Date("2026-01-01T10:02:00.000Z"));
  });

  it("forgets an expired hold without giving its inventory back", async () => {
    // As Redis will: the key is gone, the counter is not restored. That gap
    // is the sweeper's job (TB-026), and a fake that closed it would hide
    // the reason the sweeper exists.
    const { store, clock } = storeAt(START);
    store.seed(TIER, 10);
    await store.reserve(held(4));

    clock.advance(TTL_MS);

    expect(await store.find(TOKEN)).toBeNull();
    expect(await store.release(TOKEN)).toEqual({ released: false });
    expect(await store.availability([TIER])).toEqual(new Map([[TIER, 6]]));
  });
});

describe("InMemoryHoldStore as the sweeper sees it", () => {
  it("lists an expired hold with its quantity and tier, hides it from find, and sweeps it once", async () => {
    const { store, clock } = storeAt("2026-01-01T10:00:00.000Z");
    store.seed(TIER, 10);
    await store.reserve(
      aHold().forTier(TIER).withToken("tok-1").withQty(3).createdAt(clock.now()).build(),
    );
    clock.advance(120_000);

    const listed = await store.expired(clock.now());
    const found = await store.find(holdToken("tok-1"));
    const first = await store.sweep(
      { token: holdToken("tok-1"), tierId: TIER, qty: 3 },
      clock.now(),
    );
    const second = await store.sweep(
      { token: holdToken("tok-1"), tierId: TIER, qty: 3 },
      clock.now(),
    );

    expect(listed).toEqual([{ token: holdToken("tok-1"), tierId: TIER, qty: 3 }]);
    expect(found).toBeNull();
    expect(first).toEqual({ swept: true, restored: true, remaining: 10 });
    expect(second).toEqual({ swept: false });
  });

  it("is as strict as Redis: a sweep naming the wrong quantity or tier finds nothing", async () => {
    // The real store looks up the member the argument re-encodes to.
    const { store, clock } = storeAt("2026-01-01T10:00:00.000Z");
    store.seed(TIER, 10);
    await store.reserve(
      aHold().forTier(TIER).withToken("tok-1").withQty(3).createdAt(clock.now()).build(),
    );
    clock.advance(120_000);

    const wrongQty = await store.sweep(
      { token: holdToken("tok-1"), tierId: TIER, qty: 2 },
      clock.now(),
    );
    const wrongTier = await store.sweep(
      { token: holdToken("tok-1"), tierId: tierId("11111111-1111-4111-8111-bbbbbbbbbbbb"), qty: 3 },
      clock.now(),
    );

    expect(wrongQty).toEqual({ swept: false });
    expect(wrongTier).toEqual({ swept: false });
    expect(await store.availability([TIER])).toEqual(new Map([[TIER, 7]]));
  });

  it("refuses to sweep a hold that is still alive", async () => {
    const { store, clock } = storeAt("2026-01-01T10:00:00.000Z");
    store.seed(TIER, 10);
    await store.reserve(
      aHold().forTier(TIER).withToken("tok-1").withQty(3).createdAt(clock.now()).build(),
    );
    clock.advance(119_999);

    const result = await store.sweep(
      { token: holdToken("tok-1"), tierId: TIER, qty: 3 },
      clock.now(),
    );

    expect(result).toEqual({ swept: false });
    expect(await store.expired(clock.now())).toEqual([]);
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
