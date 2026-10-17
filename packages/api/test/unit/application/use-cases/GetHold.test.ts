import { describe, expect, it } from "vitest";
import { GetHoldUseCase } from "../../../../src/application/use-cases/GetHold.js";
import { Hold } from "../../../../src/domain/entities/Hold.js";
import { holdToken } from "../../../../src/domain/value-objects/HoldToken.js";
import { tierId } from "../../../../src/domain/value-objects/Ids.js";
import { Quantity } from "../../../../src/domain/value-objects/Quantity.js";
import { aHold } from "../../../fakes/builders.js";
import { FakeClock } from "../../../fakes/FakeClock.js";
import { InMemoryHoldStore } from "../../../fakes/InMemoryHoldStore.js";
import { stubHoldStore } from "../../../fakes/stubHoldStore.js";

const TTL_MS = 120_000;
const TIER = tierId("11111111-1111-4111-8111-aaaaaaaaaaaa");
const TOKEN = holdToken("tok-1");

// A world with one live hold for 2 tickets, created at 10:00:00 with a
// two-minute TTL.
async function world(): Promise<{ useCase: GetHoldUseCase; clock: FakeClock }> {
  const clock = new FakeClock("2026-01-01T10:00:00.000Z");
  const holds = new InMemoryHoldStore(clock);
  holds.seed(TIER, 10);
  await holds.reserve(
    aHold()
      .forTier(TIER)
      .withToken(TOKEN)
      .withQty(2)
      .createdAt(clock.now())
      .withTtl(TTL_MS)
      .build(),
  );
  return { useCase: new GetHoldUseCase(holds, clock), clock };
}

describe("GetHoldUseCase", () => {
  it("returns the hold with the time it has left", async () => {
    const { useCase } = await world();

    const result = await useCase.execute({ token: TOKEN });

    expect(result).toEqual({
      ok: true,
      token: TOKEN,
      tierId: TIER,
      qty: 2,
      expiresAt: new Date("2026-01-01T10:02:00.000Z"),
      remainingMs: TTL_MS,
    });
  });

  it("counts the remaining time down from the injected clock, not from the hold", async () => {
    const { useCase, clock } = await world();

    clock.advance(45_000);
    const result = await useCase.execute({ token: TOKEN });

    expect(result).toEqual(
      expect.objectContaining({
        expiresAt: new Date("2026-01-01T10:02:00.000Z"),
        remainingMs: 75_000,
      }),
    );
  });

  it("reports a token it has never seen as not found", async () => {
    const { useCase } = await world();

    const result = await useCase.execute({ token: holdToken("tok-nobody") });

    expect(result).toEqual({ ok: false, reason: "not-found" });
  });

  it("is still there one ms before its expiry and gone at the expiry instant", async () => {
    const { useCase, clock } = await world();

    clock.advance(TTL_MS - 1);
    const alive = await useCase.execute({ token: TOKEN });
    clock.advance(1);
    const gone = await useCase.execute({ token: TOKEN });

    expect(alive).toEqual(expect.objectContaining({ ok: true, remainingMs: 1 }));
    expect(gone).toEqual({ ok: false, reason: "not-found" });
  });

  it("does not trust the store on time: an expired hold it hands back is not found", async () => {
    const clock = new FakeClock("2026-01-01T10:00:00.000Z");
    const expired = Hold.create({
      token: TOKEN,
      tierId: TIER,
      qty: Quantity.of(1),
      now: new Date("2026-01-01T09:00:00.000Z"),
      ttlMs: TTL_MS,
    });
    const storeThatForgotToExpire = stubHoldStore({ find: async () => expired });

    const result = await new GetHoldUseCase(storeThatForgotToExpire, clock).execute({
      token: TOKEN,
    });

    expect(result).toEqual({ ok: false, reason: "not-found" });
  });

  it("reads the clock after the lookup, so it never overstates the time left", async () => {
    // A slow store: the second it spends answering must come off the
    // countdown the client is told, not be hidden by a clock read too early.
    const clock = new FakeClock("2026-01-01T10:00:00.000Z");
    const hold = Hold.create({
      token: TOKEN,
      tierId: TIER,
      qty: Quantity.of(1),
      now: clock.now(),
      ttlMs: TTL_MS,
    });
    const slowStore = stubHoldStore({
      find: async () => {
        clock.advance(1_000);
        return hold;
      },
    });

    const result = await new GetHoldUseCase(slowStore, clock).execute({ token: TOKEN });

    expect(result).toEqual(expect.objectContaining({ ok: true, remainingMs: TTL_MS - 1_000 }));
  });
});
