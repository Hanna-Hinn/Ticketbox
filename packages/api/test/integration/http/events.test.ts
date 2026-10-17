import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GetEventAvailabilityUseCase } from "../../../src/application/use-cases/GetEventAvailability.js";
import { ListUpcomingEventsUseCase } from "../../../src/application/use-cases/ListUpcomingEvents.js";
import { tierId } from "../../../src/domain/value-objects/Ids.js";
import { runMigrations } from "../../../src/infrastructure/postgres/migrations.js";
import { PgEventRepository } from "../../../src/infrastructure/postgres/PgEventRepository.js";
import { seed } from "../../../src/infrastructure/postgres/seed.js";
import { EventController } from "../../../src/presentation/http/controllers/EventController.js";
import { GetCacheStatsUseCase } from "../../../src/application/use-cases/GetCacheStats.js";
import { StatsController } from "../../../src/presentation/http/controllers/StatsController.js";
import { ReleaseHoldUseCase } from "../../../src/application/use-cases/ReleaseHold.js";
import { HoldController } from "../../../src/presentation/http/controllers/HoldController.js";
import { InMemoryCacheStats } from "../../fakes/InMemoryCacheStats.js";
import { buildServer } from "../../../src/presentation/http/server.js";
import { FakeClock } from "../../fakes/FakeClock.js";
import { InMemoryHoldRepository } from "../../fakes/InMemoryHoldRepository.js";
import { InMemoryHoldStore } from "../../fakes/InMemoryHoldStore.js";
import { connectToTestDatabase, resetSchema } from "../support/database.js";

const unusedStats = new StatsController(new GetCacheStatsUseCase(new InMemoryCacheStats()));

const migrationsDir = fileURLToPath(new URL("../../../../../migrations/", import.meta.url));
const JAZZ = "11111111-1111-4111-8111-111111111111";
const GENERAL = tierId("11111111-1111-4111-8111-aaaaaaaaaaaa");
const UNKNOWN = "00000000-0000-4000-8000-000000000000";

// One real adapter (PgEventRepository on the test database), everything
// else faked, no port opened: app.inject drives the server in-process.
let client: pg.Client;
let holds: InMemoryHoldStore;
let getAvailability: GetEventAvailabilityUseCase;
let clock: FakeClock;
let app: FastifyInstance;

beforeAll(async () => {
  client = await connectToTestDatabase();
  await resetSchema(client);
  await runMigrations(client, migrationsDir);
  await seed(client);
  const repo = new PgEventRepository(client);
  clock = new FakeClock("2000-01-01T00:00:00.000Z");
  holds = new InMemoryHoldStore(clock);
  getAvailability = new GetEventAvailabilityUseCase(repo, holds);
  app = buildServer({
    stats: unusedStats,
    holds: new HoldController(new ReleaseHoldUseCase(holds, new InMemoryHoldRepository())),
    logger: pino({ level: "silent" }),
    events: new EventController(new ListUpcomingEventsUseCase(repo, clock), getAvailability),
    checks: {},
  });
});

afterAll(async () => {
  await app.close();
  await client.end();
});

describe("GET /events/:id", () => {
  it("returns 200 with the event, its tiers, integer cents and an ISO start", async () => {
    const response = await app.inject({ method: "GET", url: `/events/${JAZZ}` });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ startsAt: string; tiers: unknown[] }>();
    expect(body).toMatchObject({
      id: JAZZ,
      name: "Rooftop Jazz Night",
      venue: "The Terrace, Ramallah",
    });
    expect(body.startsAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(body.tiers).toEqual([
      { id: GENERAL, name: "General", priceCents: 2000, total: 1000, remaining: 1000 },
      {
        id: "11111111-1111-4111-8111-bbbbbbbbbbbb",
        name: "Balcony",
        priceCents: 3500,
        total: 200,
        remaining: 200,
      },
      {
        id: "11111111-1111-4111-8111-cccccccccccc",
        name: "VIP",
        priceCents: 8000,
        total: 0,
        remaining: 0,
      },
    ]);
  });

  it("returns 404 with the error envelope for a well-formed id that matches nothing", async () => {
    const response = await app.inject({ method: "GET", url: `/events/${UNKNOWN}` });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: "NOT_FOUND", message: `event ${UNKNOWN} not found` },
    });
  });

  it("returns 400 from schema validation for a malformed id, without reaching the use case", async () => {
    const execute = vi.spyOn(getAvailability, "execute");

    const response = await app.inject({ method: "GET", url: "/events/not-a-uuid" });

    expect(response.statusCode).toBe(400);
    expect(execute).not.toHaveBeenCalled();
    execute.mockRestore();
  });

  it("accepts an uppercase id and the nil uuid as well-formed", async () => {
    const upper = await app.inject({ method: "GET", url: `/events/${JAZZ.toUpperCase()}` });
    const nil = await app.inject({
      method: "GET",
      url: "/events/00000000-0000-0000-0000-000000000000",
    });

    expect(upper.statusCode).toBe(200);
    expect(nil.statusCode).toBe(404);
  });

  it("refuses to serialise a negative remaining count instead of sending it", async () => {
    holds.seed(GENERAL, -1);

    const response = await app.inject({ method: "GET", url: `/events/${JAZZ}` });

    holds.seed(GENERAL, 1000);
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: { code: "INTERNAL", message: "internal error" } });
    expect(response.body).not.toContain("-1");
  });
});

describe("GET /events", () => {
  it("returns summaries of upcoming events without tiers", async () => {
    const response = await app.inject({ method: "GET", url: "/events" });

    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>[]>();
    expect(body.map((e) => e.name)).toEqual([
      "Rooftop Jazz Night",
      "Late Night Comedy",
      "Indie Film Marathon",
    ]);
    expect(body[0]).not.toHaveProperty("tiers");
  });

  it("returns an empty list when the injected clock is past every event", async () => {
    clock.advance(1000 * 60 * 60 * 24 * 365 * 100);

    const response = await app.inject({ method: "GET", url: "/events" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });
});

describe("x-response-time", () => {
  it.each([
    ["200", `/events/${JAZZ}`],
    ["404 envelope", `/events/${UNKNOWN}`],
    ["400 validation", "/events/not-a-uuid"],
    ["unknown route", "/nope"],
  ])("is present on a %s response", async (_label, url) => {
    const response = await app.inject({ method: "GET", url });

    expect(response.headers["x-response-time"]).toMatch(/^\d+\.\d{2}$/);
  });
});
