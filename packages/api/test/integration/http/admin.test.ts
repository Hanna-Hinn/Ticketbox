import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { ReconcileEventUseCase } from "../../../src/application/use-cases/ReconcileEvent.js";
import { tierId } from "../../../src/domain/value-objects/Ids.js";
import { AdminController } from "../../../src/presentation/http/controllers/AdminController.js";
import { buildServer } from "../../../src/presentation/http/server.js";
import { aTier, anEvent, DEFAULT_EVENT_ID } from "../../fakes/builders.js";
import { FakeClock } from "../../fakes/FakeClock.js";
import { InMemoryEventRepository } from "../../fakes/InMemoryEventRepository.js";
import { InMemoryHoldRepository } from "../../fakes/InMemoryHoldRepository.js";
import { InMemoryHoldStore } from "../../fakes/InMemoryHoldStore.js";
import { unusedEventController, unusedHoldController, unusedStatsController } from "./support.js";

// The route and the controller over fakes: one seeded event with one tier
// of 10, a store that says 7. The real engines are main/composition.test.ts.
const TIER = tierId("11111111-1111-4111-8111-aaaaaaaaaaaa");
const ok = (): Promise<void> => Promise.resolve();

let app: FastifyInstance;

function server(): FastifyInstance {
  const store = new InMemoryHoldStore(new FakeClock("2026-01-01T00:00:00.000Z"));
  store.seed(TIER, 7);
  const events = new InMemoryEventRepository([
    anEvent()
      .withTiers([aTier().withRemaining(10).build()])
      .build(),
  ]);
  app = buildServer({
    logger: pino({ level: "silent" }),
    events: unusedEventController(),
    holds: unusedHoldController(),
    stats: unusedStatsController(),
    admin: new AdminController(
      new ReconcileEventUseCase(events, store, new InMemoryHoldRepository()),
    ),
    checks: { postgres: ok, redis: ok },
  });
  return app;
}

afterEach(async () => {
  await app.close();
});

describe("POST /_admin/reconcile/:eventId", () => {
  it("answers 200 with the report: each tier's counter before and after, and the mirror's repairs", async () => {
    const response = await server().inject({
      method: "POST",
      url: `/_admin/reconcile/${DEFAULT_EVENT_ID}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      eventId: DEFAULT_EVENT_ID,
      tiers: [{ tierId: TIER, before: 7, after: 10 }],
      rowsExpired: 0,
      unrecorded: [],
    });
  });

  it("answers 404 NOT_FOUND for an event that does not exist", async () => {
    const response = await server().inject({
      method: "POST",
      url: "/_admin/reconcile/22222222-2222-4222-8222-222222222222",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: "NOT_FOUND", message: expect.stringMatching(/^event /) },
    });
  });

  it("answers 400 VALIDATION for an id that is not a uuid, before any use case runs", async () => {
    const response = await server().inject({ method: "POST", url: "/_admin/reconcile/jazz" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "VALIDATION" } });
  });
});
