import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { GetCacheStatsUseCase } from "../../../src/application/use-cases/GetCacheStats.js";
import { StatsController } from "../../../src/presentation/http/controllers/StatsController.js";
import {
  freshIdempotencyStore,
  unusedAdminController,
  unusedEventController,
  unusedHoldController,
  unusedOrderController,
} from "./support.js";
import { buildServer } from "../../../src/presentation/http/server.js";
import { InMemoryCacheStats } from "../../fakes/InMemoryCacheStats.js";

// The route, the controller and the use case against a faked counter: no
// engine is opened. The real adapter behind /_stats is covered by
// main/composition.test.ts.
const ok = (): Promise<void> => Promise.resolve();

let app: FastifyInstance;

function serverWith(stats: InMemoryCacheStats): FastifyInstance {
  app = buildServer({
    logger: pino({ level: "silent" }),
    events: unusedEventController(),
    stats: new StatsController(new GetCacheStatsUseCase(stats)),
    admin: unusedAdminController(),
    holds: unusedHoldController(),
    orders: unusedOrderController(),
    idempotency: freshIdempotencyStore(),
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
