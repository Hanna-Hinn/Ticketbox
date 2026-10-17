import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { GetEventAvailabilityUseCase } from "../../../src/application/use-cases/GetEventAvailability.js";
import { ListUpcomingEventsUseCase } from "../../../src/application/use-cases/ListUpcomingEvents.js";
import { EventController } from "../../../src/presentation/http/controllers/EventController.js";
import { GetCacheStatsUseCase } from "../../../src/application/use-cases/GetCacheStats.js";
import { StatsController } from "../../../src/presentation/http/controllers/StatsController.js";
import { InMemoryCacheStats } from "../../fakes/InMemoryCacheStats.js";
import { buildServer, type ServerDeps } from "../../../src/presentation/http/server.js";
import { FakeClock } from "../../fakes/FakeClock.js";
import { InMemoryEventRepository } from "../../fakes/InMemoryEventRepository.js";
import { InMemoryHoldStore } from "../../fakes/InMemoryHoldStore.js";

const unusedStats = new StatsController(new GetCacheStatsUseCase(new InMemoryCacheStats()));

// The event controller is irrelevant here; an empty in-memory world keeps the
// server buildable without a database.
const noEvents = new InMemoryEventRepository([]);
const unusedEvents = new EventController(
  new ListUpcomingEventsUseCase(noEvents, new FakeClock("2026-01-01T00:00:00.000Z")),
  new GetEventAvailabilityUseCase(noEvents, new InMemoryHoldStore()),
);

const ok = (): Promise<void> => Promise.resolve();
const down = (): Promise<void> => Promise.reject(new Error("connection refused"));
const hung = (): Promise<void> => new Promise(() => undefined);

let app: FastifyInstance;

function serverWith(checks: ServerDeps["checks"]): FastifyInstance {
  app = buildServer({
    stats: unusedStats,
    logger: pino({ level: "silent" }),
    events: unusedEvents,
    checks,
    healthCheckTimeoutMs: 50,
  });
  return app;
}

afterEach(async () => {
  await app.close();
});

describe("GET /health", () => {
  it("is 200 ok when every engine answers", async () => {
    const response = await serverWith({ postgres: ok, redis: ok }).inject({ url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", checks: { postgres: "ok", redis: "ok" } });
  });

  it("reports each engine separately when one is down", async () => {
    const response = await serverWith({ postgres: ok, redis: down }).inject({ url: "/health" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: "degraded",
      checks: { postgres: "ok", redis: "down" },
    });
  });

  it("does not let an engine that never answers hide the one that does", async () => {
    const response = await serverWith({ postgres: ok, redis: hung }).inject({ url: "/health" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: "degraded",
      checks: { postgres: "ok", redis: "down" },
    });
  });
});
