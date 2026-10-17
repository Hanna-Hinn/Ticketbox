import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { GetCacheStatsUseCase } from "../../../src/application/use-cases/GetCacheStats.js";
import { GetEventAvailabilityUseCase } from "../../../src/application/use-cases/GetEventAvailability.js";
import { ListUpcomingEventsUseCase } from "../../../src/application/use-cases/ListUpcomingEvents.js";
import { ReleaseHoldUseCase } from "../../../src/application/use-cases/ReleaseHold.js";
import { tierId } from "../../../src/domain/value-objects/Ids.js";
import { EventController } from "../../../src/presentation/http/controllers/EventController.js";
import { HoldController } from "../../../src/presentation/http/controllers/HoldController.js";
import { StatsController } from "../../../src/presentation/http/controllers/StatsController.js";
import { buildServer } from "../../../src/presentation/http/server.js";
import { aHold } from "../../fakes/builders.js";
import { FakeClock } from "../../fakes/FakeClock.js";
import { InMemoryCacheStats } from "../../fakes/InMemoryCacheStats.js";
import { InMemoryEventRepository } from "../../fakes/InMemoryEventRepository.js";
import { InMemoryHoldRepository } from "../../fakes/InMemoryHoldRepository.js";
import { InMemoryHoldStore } from "../../fakes/InMemoryHoldStore.js";

// The route, the controller and the use case over the in-memory store: no
// engine opened. The script behind the real store has its own tests.
const TIER = tierId("11111111-1111-4111-8111-aaaaaaaaaaaa");
const TOKEN = "11111111-1111-4111-8111-aaaaaaaaaaa1";
const ok = (): Promise<void> => Promise.resolve();
const noEvents = new InMemoryEventRepository([]);
const unusedEvents = new EventController(
  new ListUpcomingEventsUseCase(noEvents, new FakeClock("2026-01-01T00:00:00.000Z")),
  new GetEventAvailabilityUseCase(
    noEvents,
    new InMemoryHoldStore(new FakeClock("2026-01-01T00:00:00.000Z")),
  ),
);
const unusedStats = new StatsController(new GetCacheStatsUseCase(new InMemoryCacheStats()));

let app: FastifyInstance;

async function serverWithHold(): Promise<{ app: FastifyInstance; holds: InMemoryHoldStore }> {
  const clock = new FakeClock("2026-01-01T10:00:00.000Z");
  const holds = new InMemoryHoldStore(clock);
  holds.seed(TIER, 10);
  await holds.reserve(
    aHold().forTier(TIER).withToken(TOKEN).withQty(2).createdAt(clock.now()).build(),
  );
  app = buildServer({
    logger: pino({ level: "silent" }),
    events: unusedEvents,
    holds: new HoldController(new ReleaseHoldUseCase(holds, new InMemoryHoldRepository())),
    stats: unusedStats,
    checks: { postgres: ok, redis: ok },
  });
  return { app, holds };
}

afterEach(async () => {
  await app.close();
});

describe("DELETE /holds/:token", () => {
  it("releases a live hold and answers released: true", async () => {
    const { app, holds } = await serverWithHold();

    const response = await app.inject({ method: "DELETE", url: `/holds/${TOKEN}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ released: true });
    expect(await holds.availability([TIER])).toEqual(new Map([[TIER, 10]]));
  });

  it("answers released: false, still 200, for a token that is gone or never existed", async () => {
    const { app } = await serverWithHold();
    await app.inject({ method: "DELETE", url: `/holds/${TOKEN}` });

    const again = await app.inject({ method: "DELETE", url: `/holds/${TOKEN}` });
    const never = await app.inject({
      method: "DELETE",
      url: "/holds/00000000-0000-4000-8000-000000000000",
    });

    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ released: false });
    expect(never.statusCode).toBe(200);
    expect(never.json()).toEqual({ released: false });
  });

  it("rejects a malformed token with the 400 envelope before any use case runs", async () => {
    const { app } = await serverWithHold();

    const response = await app.inject({ method: "DELETE", url: "/holds/not-a-token" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: expect.any(String) } });
  });
});
