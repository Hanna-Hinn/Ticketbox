import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GetEventAvailabilityUseCase } from "../../../src/application/use-cases/GetEventAvailability.js";
import { ListUpcomingEventsUseCase } from "../../../src/application/use-cases/ListUpcomingEvents.js";
import { InvalidQuantity } from "../../../src/domain/errors/InvalidQuantity.js";
import { TierNotFound } from "../../../src/domain/errors/TierNotFound.js";
import { EventController } from "../../../src/presentation/http/controllers/EventController.js";
import { unusedHoldController, unusedStatsController } from "./support.js";
import { buildServer } from "../../../src/presentation/http/server.js";
import { FakeClock } from "../../fakes/FakeClock.js";
import { InMemoryEventRepository } from "../../fakes/InMemoryEventRepository.js";
import { InMemoryHoldStore } from "../../fakes/InMemoryHoldStore.js";

// The single error handler, exercised through throwaway routes that throw
// what real routes will throw later. The logger writes to memory so the
// test can read what an operator would.
const logLines: string[] = [];
const sink = new Writable({
  write(chunk: Buffer, _encoding, done) {
    logLines.push(chunk.toString());
    done();
  },
});

let app: FastifyInstance;

beforeAll(async () => {
  const noEvents = new InMemoryEventRepository([]);
  app = buildServer({
    stats: unusedStatsController(),
    holds: unusedHoldController(),
    logger: pino({ level: "info" }, sink),
    events: new EventController(
      new ListUpcomingEventsUseCase(noEvents, new FakeClock("2026-01-01T00:00:00.000Z")),
      new GetEventAvailabilityUseCase(
        noEvents,
        new InMemoryHoldStore(new FakeClock("2026-01-01T00:00:00.000Z")),
      ),
    ),
    checks: {},
  });
  app.get("/throw/tier-not-found", async () => {
    throw new TierNotFound("t-1");
  });
  app.get("/throw/unexpected", async () => {
    throw new Error("boom: secret");
  });
  app.get("/throw/invariant", async () => {
    throw new InvalidQuantity("quantity must be an integer between 1 and 10, got 11");
  });
  app.post("/echo", async (request) => request.body);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("the error handler", () => {
  it("maps a thrown TierNotFound to 404 with the envelope", async () => {
    const response = await app.inject({ url: "/throw/tier-not-found" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: "NOT_FOUND", message: "tier t-1 not found" },
    });
  });

  it("maps an unexpected error to 500 and leaks neither message nor stack", async () => {
    const response = await app.inject({ url: "/throw/unexpected" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: { code: "INTERNAL", message: "internal error" } });
    expect(response.body).not.toMatch(/boom|secret|\bat /);
  });

  it("treats a domain invariant violation as a bug: 500, nothing leaked", async () => {
    const response = await app.inject({ url: "/throw/invariant" });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("quantity");
  });

  it("gives Fastify's own client errors their status and the envelope", async () => {
    const xml = await app.inject({
      method: "POST",
      url: "/echo",
      headers: { "content-type": "application/xml" },
      payload: "<a/>",
    });
    const badJson = await app.inject({
      method: "POST",
      url: "/echo",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });

    expect(xml.statusCode).toBe(415);
    expect(xml.json()).toMatchObject({ error: { code: "BAD_REQUEST" } });
    expect(badJson.statusCode).toBe(400);
    expect(badJson.json()).toMatchObject({ error: { code: "BAD_REQUEST" } });
  });

  it("wraps a schema validation failure in the envelope", async () => {
    const response = await app.inject({ url: "/events/not-a-uuid" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: "VALIDATION", message: "params/id Invalid UUID" },
    });
  });

  it("answers an unknown route with the envelope and no echo of the path", async () => {
    const response = await app.inject({ url: "/nope?x=../../etc" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: "NOT_FOUND", message: "route not found" } });
  });
});

describe("the correlation id", () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it("is generated when the client sends none, on error replies too", async () => {
    const ok = await app.inject({ url: "/events" });
    const notFound = await app.inject({ url: "/nope" });
    const failed = await app.inject({ url: "/throw/unexpected" });

    for (const response of [ok, notFound, failed]) {
      expect(response.headers["x-correlation-id"]).toMatch(UUID);
      expect(response.headers["x-response-time"]).toMatch(/^\d+\.\d{2}$/);
    }
  });

  it("echoes a well-formed client id", async () => {
    const response = await app.inject({
      url: "/events",
      headers: { "x-correlation-id": "abc-123_XYZ" },
    });

    expect(response.headers["x-correlation-id"]).toBe("abc-123_XYZ");
  });

  it.each([
    ["65 characters", "a".repeat(65)],
    ["whitespace", "a b"],
    ["path-like", "../../etc/passwd"],
  ])("replaces a client id that is %s rather than echoing it", async (_label, supplied) => {
    const response = await app.inject({
      url: "/events",
      headers: { "x-correlation-id": supplied },
    });

    expect(response.headers["x-correlation-id"]).toMatch(UUID);
  });

  it("is the reqId on the log line of the failure it belongs to, and the request line carries no headers", async () => {
    logLines.length = 0;

    const response = await app.inject({
      url: "/throw/unexpected",
      headers: { "x-correlation-id": "corr-for-the-log", authorization: "Bearer secret" },
    });

    const lines = logLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const errorLine = lines.find((line) => line.msg === "unhandled error");
    const requestLine = lines.find((line) => line.msg === "incoming request");
    expect(response.headers["x-correlation-id"]).toBe("corr-for-the-log");
    expect(errorLine?.reqId).toBe("corr-for-the-log");
    expect(JSON.stringify(errorLine)).toContain("boom: secret");
    expect(requestLine?.reqId).toBe("corr-for-the-log");
    expect(JSON.stringify(requestLine)).not.toContain("Bearer");
  });
});
