import { describe, expect, it } from "vitest";
import type { HoldStore } from "../../../../src/application/ports/HoldStore.js";
import { ConfirmOrderUseCase } from "../../../../src/application/use-cases/ConfirmOrder.js";
import { CreateHoldUseCase } from "../../../../src/application/use-cases/CreateHold.js";
import { ReleaseHoldUseCase } from "../../../../src/application/use-cases/ReleaseHold.js";
import { holdToken } from "../../../../src/domain/value-objects/HoldToken.js";
import { orderId, tierId } from "../../../../src/domain/value-objects/Ids.js";
import { aTier, anEvent, DEFAULT_EVENT_ID } from "../../../fakes/builders.js";
import { FakeClock } from "../../../fakes/FakeClock.js";
import { FixedTokenGenerator } from "../../../fakes/FixedTokenGenerator.js";
import { InMemoryEventRepository } from "../../../fakes/InMemoryEventRepository.js";
import { InMemoryHoldRepository } from "../../../fakes/InMemoryHoldRepository.js";
import { InMemoryHoldStore } from "../../../fakes/InMemoryHoldStore.js";
import { InMemoryOrderRepository } from "../../../fakes/InMemoryOrderRepository.js";
import { stubHoldStore } from "../../../fakes/stubHoldStore.js";

const TTL_MS = 120_000;
const TIER = tierId("11111111-1111-4111-8111-aaaaaaaaaaaa");
const TOKEN = holdToken("tok-1");
const START = "2026-01-01T10:00:00.000Z";

// A world with 10 tickets at €20, 2 of them held under TOKEN since
// 10:00:00, with their row; the confirm comes 30 s later.
async function world(): Promise<{
  confirm: ConfirmOrderUseCase;
  store: InMemoryHoldStore;
  mirror: InMemoryHoldRepository;
  orders: InMemoryOrderRepository;
  clock: FakeClock;
  ids: FixedTokenGenerator;
}> {
  const clock = new FakeClock(START);
  const events = new InMemoryEventRepository([
    anEvent()
      .withTiers([aTier().withRemaining(10).build()])
      .build(),
  ]);
  const store = new InMemoryHoldStore(clock);
  store.seed(TIER, 10);
  const mirror = new InMemoryHoldRepository();
  await new CreateHoldUseCase(
    events,
    store,
    mirror,
    clock,
    new FixedTokenGenerator(["tok-1"]),
    TTL_MS,
  ).execute({ eventId: DEFAULT_EVENT_ID, tierId: TIER, qty: 2 });
  const orders = new InMemoryOrderRepository(mirror);
  const ids = new FixedTokenGenerator(["o-1", "o-2"]);
  clock.advance(30_000);
  return {
    confirm: new ConfirmOrderUseCase(events, store, orders, clock, ids),
    store,
    mirror,
    orders,
    clock,
    ids,
  };
}

const request = { holdToken: TOKEN, email: "hanna@example.com", idempotencyKey: null };

describe("ConfirmOrderUseCase", () => {
  it("turns a live hold into an order at the tier's price, and the hold's row into converted", async () => {
    const { confirm, store, mirror, orders } = await world();

    const result = await confirm.execute(request);

    expect(result).toEqual({
      ok: true,
      orderId: orderId("o-1"),
      holdToken: TOKEN,
      email: "hanna@example.com",
      totalCents: 4000,
      items: [{ tierId: TIER, qty: 2, unitPriceCents: 2000 }],
      createdAt: new Date("2026-01-01T10:00:30.000Z"),
    });
    expect(orders.saved(orderId("o-1"))?.total().cents).toBe(4000);
    expect(mirror.statusOf(TOKEN)).toBe("converted");
    expect(await store.find(TOKEN)).toBeNull();
  });

  it("does not give the tickets back: sold, not released", async () => {
    const { confirm, store } = await world();

    await confirm.execute(request);

    expect(await store.availability([TIER])).toEqual(new Map([[TIER, 8]]));
  });

  it("rejects an expired hold without touching the store or the orders", async () => {
    const { confirm, store, orders, clock } = await world();
    clock.advance(TTL_MS);

    const result = await confirm.execute(request);

    expect(result).toEqual({ ok: false, reason: "hold-gone" });
    expect(orders.size).toBe(0);
    // Still held by the store's count: expiry is the sweeper's to restore.
    expect(await store.availability([TIER])).toEqual(new Map([[TIER, 8]]));
  });

  it("asks the entity, not only the store, whether the hold has expired", async () => {
    // The store still answers the hold (its TTL has not fired); the entity
    // says it is over. The confirm agrees with GetHold, and never consumes.
    const clock = new FakeClock(START);
    const hold = (await world()).store;
    const live = await hold.find(TOKEN);
    if (live === null) throw new Error("the world did not hold");
    const store = stubHoldStore({ find: async () => live });
    const events = new InMemoryEventRepository([anEvent().withTiers([aTier().build()]).build()]);
    clock.advance(TTL_MS);
    const confirm = new ConfirmOrderUseCase(
      events,
      store,
      new InMemoryOrderRepository(new InMemoryHoldRepository()),
      clock,
      new FixedTokenGenerator(["o-1"]),
    );

    const result = await confirm.execute(request);

    expect(result).toEqual({ ok: false, reason: "hold-gone" });
  });

  it("rejects a hold that was already confirmed, leaving exactly one order", async () => {
    const { confirm, orders } = await world();

    const first = await confirm.execute(request);
    const second = await confirm.execute(request);

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: "hold-gone" });
    expect(orders.size).toBe(1);
  });

  it("rejects a hold that was released", async () => {
    const { confirm, store, mirror, orders } = await world();
    await new ReleaseHoldUseCase(store, mirror).execute({ token: TOKEN });

    const result = await confirm.execute(request);

    expect(result).toEqual({ ok: false, reason: "hold-gone" });
    expect(orders.size).toBe(0);
    expect(mirror.statusOf(TOKEN)).toBe("released");
  });

  it("answers hold-gone, and writes nothing, when the store refuses between the read and the consume", async () => {
    const { store, clock } = await world();
    const live = await store.find(TOKEN);
    if (live === null) throw new Error("the world did not hold");
    const racing = stubHoldStore({ find: async () => live, consume: async () => false });
    const mirror = new InMemoryHoldRepository();
    await mirror.save(live);
    const orders = new InMemoryOrderRepository(mirror);
    const confirm = new ConfirmOrderUseCase(
      new InMemoryEventRepository([anEvent().withTiers([aTier().build()]).build()]),
      racing,
      orders,
      clock,
      new FixedTokenGenerator(["o-1"]),
    );

    const result = await confirm.execute(request);

    expect(result).toEqual({ ok: false, reason: "hold-gone" });
    expect(orders.size).toBe(0);
    expect(mirror.statusOf(TOKEN)).toBe("active");
  });

  it("lets a failed record escape with the hold already consumed: an under-sell, never an oversell", async () => {
    // ADR 0007: Redis decides first. If Postgres then fails, the hold is
    // gone and no order exists; the sweeper will not restore it (nothing
    // to restore from) and reconcile expires the row later.
    const { store, mirror, clock } = await world();
    const down = {
      save: () => Promise.reject(new Error("postgres is down")),
    };
    const confirm = new ConfirmOrderUseCase(
      new InMemoryEventRepository([anEvent().withTiers([aTier().build()]).build()]),
      store,
      down,
      clock,
      new FixedTokenGenerator(["o-1"]),
    );

    await expect(confirm.execute(request)).rejects.toThrow("postgres is down");

    expect(await store.find(TOKEN)).toBeNull();
    expect(mirror.statusOf(TOKEN)).toBe("active");
    expect(await store.availability([TIER])).toEqual(new Map([[TIER, 8]]));
  });

  it("fails the confirm, not the audit trail, when reconcile expires the row between consume and record", async () => {
    // The window ADR 0007 names: after the consume the hold is gone from
    // both keys, which is reconcile's own test for "expire the row".
    const { store, mirror, clock } = await world();
    const orders = new InMemoryOrderRepository(mirror);
    const interleaved: HoldStore = stubHoldStore({
      find: (token) => store.find(token),
      consume: async (token) => {
        const consumed = await store.consume(token);
        await mirror.setStatus(token, "expired"); // reconcile lands here
        return consumed;
      },
    });
    const confirm = new ConfirmOrderUseCase(
      new InMemoryEventRepository([anEvent().withTiers([aTier().build()]).build()]),
      interleaved,
      orders,
      clock,
      new FixedTokenGenerator(["o-1"]),
    );

    await expect(confirm.execute(request)).rejects.toThrow(/no active row/);

    expect(orders.size).toBe(0);
    expect(mirror.statusOf(TOKEN)).toBe("expired");
  });

  it("reads the clock once: the order's instant is the one the expiry check used", async () => {
    let reads = 0;
    const base = new Date("2026-01-01T10:00:30.000Z").getTime();
    const clock = {
      now: (): Date => {
        reads += 1;
        return new Date(base + reads);
      },
    };
    const { store, mirror } = await world();
    const confirm = new ConfirmOrderUseCase(
      new InMemoryEventRepository([anEvent().withTiers([aTier().build()]).build()]),
      store,
      new InMemoryOrderRepository(mirror),
      clock,
      new FixedTokenGenerator(["o-1"]),
    );

    const result = await confirm.execute(request);

    expect(reads).toBe(1);
    expect(result.ok && result.createdAt.getTime()).toBe(base + 1);
  });

  it("carries the client's idempotency key into the order, and none when there was none", async () => {
    const { confirm, orders } = await world();

    await confirm.execute({ ...request, idempotencyKey: "client-key-1" });

    expect(orders.saved(orderId("o-1"))?.idempotencyKey).toBe("client-key-1");
  });

  it("treats a hold whose event or tier is missing as a bug, not as a gone hold", async () => {
    const { store, mirror, clock } = await world();
    const confirm = new ConfirmOrderUseCase(
      new InMemoryEventRepository([]),
      store,
      new InMemoryOrderRepository(mirror),
      clock,
      new FixedTokenGenerator(["o-1"]),
    );

    await expect(confirm.execute(request)).rejects.toThrow(/does not exist/);
    expect(await store.find(TOKEN)).not.toBeNull();
  });
});
