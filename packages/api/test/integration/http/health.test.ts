import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import {
  freshIdempotencyStore,
  unusedAdminController,
  unusedEventController,
  unusedHoldController,
  unusedOrderController,
  unusedStatsController,
} from "./support.js";
import { buildServer, type ServerDeps } from "../../../src/presentation/http/server.js";

const ok = (): Promise<void> => Promise.resolve();
const down = (): Promise<void> => Promise.reject(new Error("connection refused"));
const hung = (): Promise<void> => new Promise(() => undefined);

let app: FastifyInstance;

function serverWith(checks: ServerDeps["checks"]): FastifyInstance {
  app = buildServer({
    stats: unusedStatsController(),
    admin: unusedAdminController(),
    holds: unusedHoldController(),
    orders: unusedOrderController(),
    idempotency: freshIdempotencyStore(),
    logger: pino({ level: "silent" }),
    events: unusedEventController(),
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
