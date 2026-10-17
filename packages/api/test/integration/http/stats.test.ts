import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { GetCacheStatsUseCase } from "../../../src/application/use-cases/GetCacheStats.js";
import { GetEventAvailabilityUseCase } from "../../../src/application/use-cases/GetEventAvailability.js";
import { ListUpcomingEventsUseCase } from "../../../src/application/use-cases/ListUpcomingEvents.js";
import { EventController } from "../../../src/presentation/http/controllers/EventController.js";
import { StatsController } from "../../../src/presentation/http/controllers/StatsController.js";
import { ReleaseHoldUseCase } from "../../../src/application/use-cases/ReleaseHold.js";
import { HoldController } from "../../../src/presentation/http/controllers/HoldController.js";
import { buildServer } from "../../../src/presentation/http/server.js";
import { FakeClock } from "../../fakes/FakeClock.js";
import { InMemoryCacheStats } from "../../fakes/InMemoryCacheStats.js";
import { InMemoryEventRepository } from "../../fakes/InMemoryEventRepository.js";
import { InMemoryHoldStore } from "../../fakes/InMemoryHoldStore.js";

// The route, the controller and the use case against a faked counter: no
// engine is opened. The real adapter behind /_stats is covered by
// main/composition.test.ts.
const noEvents = new InMemoryEventRepository([]);
const unusedEvents = new EventController(
  new ListUpcomingEventsUseCase(noEvents, new FakeClock("2026-01-01T00:00:00.000Z")),
  new GetEventAvailabilityUseCase(
    noEvents,
    new InMemoryHoldStore(new FakeClock("2026-01-01T00:00:00.000Z")),
  ),
);
const ok = (): Promise<void> => Promise.resolve();
const unusedHolds = new HoldController(
  new ReleaseHoldUseCase(new InMemoryHoldStore(new FakeClock("2026-01-01T00:00:00.000Z"))),
);

let app: FastifyInstance;

function serverWith(stats: InMemoryCacheStats): FastifyInstance {
  app = buildServer({
    logger: pino({ level: "silent" }),
    events: unusedEvents,
    stats: new StatsController(new GetCacheStatsUseCase(stats)),
    holds: unusedHolds,
    checks: { postgres: ok, redis: ok },
  });
  return app;
}

afterEach(async () => {
  await app.close();
});

describe("GET /_stats", () => {
  it("reports the counters and the hit ratio", async () => {
    const stats = new InMemoryCacheStats();
    stats.hits = 3;
    stats.misses = 1;

    const response = await serverWith(stats).inject({ url: "/_stats" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ cache: { hits: 3, misses: 1, hitRatio: 0.75 } });
  });

  it("answers with a ratio of zero before the first lookup", async () => {
    const response = await serverWith(new InMemoryCacheStats()).inject({ url: "/_stats" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ cache: { hits: 0, misses: 0, hitRatio: 0 } });
  });
});
