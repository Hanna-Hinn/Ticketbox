import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { CreateHoldUseCase } from "../../../src/application/use-cases/CreateHold.js";
import { GetHoldUseCase } from "../../../src/application/use-cases/GetHold.js";
import { ReleaseHoldUseCase } from "../../../src/application/use-cases/ReleaseHold.js";
import { tierId } from "../../../src/domain/value-objects/Ids.js";
import { HoldController } from "../../../src/presentation/http/controllers/HoldController.js";
import { buildServer } from "../../../src/presentation/http/server.js";
import { aTier, anEvent, DEFAULT_EVENT_ID } from "../../fakes/builders.js";
import { FakeClock } from "../../fakes/FakeClock.js";
import { FixedTokenGenerator } from "../../fakes/FixedTokenGenerator.js";
import { InMemoryEventRepository } from "../../fakes/InMemoryEventRepository.js";
import { InMemoryHoldRepository } from "../../fakes/InMemoryHoldRepository.js";
import { InMemoryHoldStore } from "../../fakes/InMemoryHoldStore.js";
import { unusedEventController, unusedStatsController } from "./support.js";

// The routes, the controller and the use cases over the in-memory world: no
// engine opened. The scripts behind the real store have their own tests.
const TIER = tierId("11111111-1111-4111-8111-aaaaaaaaaaaa");
const TOKEN = "11111111-1111-4111-8111-aaaaaaaaaaa1";
const UNKNOWN = "00000000-0000-4000-8000-000000000000";
const ok = (): Promise<void> => Promise.resolve();

let app: FastifyInstance;

function server(remaining = 10): {
  app: FastifyInstance;
  holds: InMemoryHoldStore;
  clock: FakeClock;
} {
  const clock = new FakeClock("2026-01-01T10:00:00.000Z");
  const events = new InMemoryEventRepository([
    anEvent()
      .withTiers([aTier().withRemaining(remaining).build()])
      .build(),
  ]);
  const holds = new InMemoryHoldStore(clock);
  holds.seed(TIER, remaining);
  const mirror = new InMemoryHoldRepository();
  app = buildServer({
    logger: pino({ level: "silent" }),
    events: unusedEventController(),
    holds: new HoldController(
      new CreateHoldUseCase(
        events,
        holds,
        mirror,
        clock,
        new FixedTokenGenerator([TOKEN]),
        120_000,
      ),
      new GetHoldUseCase(holds, clock),
      new ReleaseHoldUseCase(holds, mirror),
    ),
    stats: unusedStatsController(),
    checks: { postgres: ok, redis: ok },
  });
  return { app, holds, clock };
}

const body = { eventId: DEFAULT_EVENT_ID, tierId: TIER, qty: 2 };

afterEach(async () => {
  await app.close();
});

describe("POST /holds", () => {
  it("answers 201 with the token, the ids, the quantity, the expiry and the new count", async () => {
    const { app } = server();

    const response = await app.inject({ method: "POST", url: "/holds", payload: body });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      token: TOKEN,
      eventId: DEFAULT_EVENT_ID,
      tierId: TIER,
      qty: 2,
      expiresAt: "2026-01-01T10:02:00.000Z",
      remaining: 8,
    });
  });

  it("answers 404 for an event or a tier that does not exist", async () => {
    const { app } = server();

    const noEvent = await app.inject({
      method: "POST",
      url: "/holds",
      payload: { ...body, eventId: UNKNOWN },
    });
    const noTier = await app.inject({
      method: "POST",
      url: "/holds",
      payload: { ...body, tierId: UNKNOWN },
    });

    expect(noEvent.statusCode).toBe(404);
    expect(noTier.statusCode).toBe(404);
    expect(noTier.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("answers 409 INSUFFICIENT when the store refuses, with the inventory untouched", async () => {
    const { app, holds } = server(1);

    const response = await app.inject({ method: "POST", url: "/holds", payload: body });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "INSUFFICIENT" } });
    expect(await holds.availability([TIER])).toEqual(new Map([[TIER, 1]]));
  });

  it.each([0, 11, 1.5])(
    "answers 400 for a quantity of %s, before touching inventory",
    async (qty) => {
      const { app, holds } = server();

      const response = await app.inject({
        method: "POST",
        url: "/holds",
        payload: { ...body, qty },
      });

      expect(response.statusCode).toBe(400);
      expect(await holds.availability([TIER])).toEqual(new Map([[TIER, 10]]));
    },
  );

  it("answers 400 for a malformed body", async () => {
    const { app } = server();

    const response = await app.inject({
      method: "POST",
      url: "/holds",
      payload: { eventId: "nope", tierId: TIER, qty: 1 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "VALIDATION" } });
  });
});

describe("GET /holds/:token", () => {
  it("answers the hold with the time it has left", async () => {
    const { app, clock } = server();
    await app.inject({ method: "POST", url: "/holds", payload: body });
    clock.advance(45_000);

    const response = await app.inject({ url: `/holds/${TOKEN}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      token: TOKEN,
      eventId: DEFAULT_EVENT_ID,
      tierId: TIER,
      qty: 2,
      expiresAt: "2026-01-01T10:02:00.000Z",
      remainingMs: 75_000,
    });
  });

  it("answers 404 for a token that expired, was released, or was never issued", async () => {
    const { app, clock } = server();
    await app.inject({ method: "POST", url: "/holds", payload: body });

    const never = await app.inject({ url: `/holds/${UNKNOWN}` });
    clock.advance(120_000);
    const expired = await app.inject({ url: `/holds/${TOKEN}` });

    expect(never.statusCode).toBe(404);
    expect(expired.statusCode).toBe(404);
    expect(expired.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });
});

describe("DELETE /holds/:token", () => {
  it("releases a live hold and answers released: true", async () => {
    const { app, holds } = server();
    await app.inject({ method: "POST", url: "/holds", payload: body });

    const response = await app.inject({ method: "DELETE", url: `/holds/${TOKEN}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ released: true });
    expect(await holds.availability([TIER])).toEqual(new Map([[TIER, 10]]));
  });

  it("answers released: false, still 200, for a token that is gone or never existed", async () => {
    const { app } = server();
    await app.inject({ method: "POST", url: "/holds", payload: body });
    await app.inject({ method: "DELETE", url: `/holds/${TOKEN}` });

    const again = await app.inject({ method: "DELETE", url: `/holds/${TOKEN}` });
    const never = await app.inject({ method: "DELETE", url: `/holds/${UNKNOWN}` });

    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ released: false });
    expect(never.statusCode).toBe(200);
    expect(never.json()).toEqual({ released: false });
  });

  it("rejects a malformed token with the 400 envelope before any use case runs", async () => {
    const { app } = server();

    const response = await app.inject({ method: "DELETE", url: "/holds/not-a-token" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: expect.any(String) } });
  });
});
