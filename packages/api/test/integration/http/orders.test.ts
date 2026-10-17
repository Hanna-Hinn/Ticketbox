import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { ConfirmOrderUseCase } from "../../../src/application/use-cases/ConfirmOrder.js";
import { CreateHoldUseCase } from "../../../src/application/use-cases/CreateHold.js";
import { holdToken } from "../../../src/domain/value-objects/HoldToken.js";
import { orderId, tierId } from "../../../src/domain/value-objects/Ids.js";
import type { ErrorDto } from "../../../src/presentation/dto/errors.js";
import { OrderController } from "../../../src/presentation/http/controllers/OrderController.js";
import { buildServer } from "../../../src/presentation/http/server.js";
import { aTier, anEvent, DEFAULT_EVENT_ID } from "../../fakes/builders.js";
import { FakeClock } from "../../fakes/FakeClock.js";
import { FixedTokenGenerator } from "../../fakes/FixedTokenGenerator.js";
import { InMemoryEventRepository } from "../../fakes/InMemoryEventRepository.js";
import { InMemoryHoldRepository } from "../../fakes/InMemoryHoldRepository.js";
import { InMemoryHoldStore } from "../../fakes/InMemoryHoldStore.js";
import { InMemoryIdempotencyStore } from "../../fakes/InMemoryIdempotencyStore.js";
import { InMemoryOrderRepository } from "../../fakes/InMemoryOrderRepository.js";
import {
  unusedAdminController,
  unusedEventController,
  unusedHoldController,
  unusedStatsController,
} from "./support.js";

// The route and the controller over fakes: two live holds of 2 at €20 on a
// tier of 10, taken at 10:00:00 and confirmed at 10:00:30. The real engines
// are main/composition.test.ts.
const TIER = tierId("11111111-1111-4111-8111-aaaaaaaaaaaa");
const HELD = "11111111-1111-4111-8111-aaaaaaaaaaa1";
const OTHER_HELD = "11111111-1111-4111-8111-aaaaaaaaaaa2";
const ok = (): Promise<void> => Promise.resolve();

let app: FastifyInstance;
let lines: string[];

async function server(): Promise<{
  app: FastifyInstance;
  store: InMemoryHoldStore;
  orders: InMemoryOrderRepository;
  idempotency: InMemoryIdempotencyStore;
}> {
  const clock = new FakeClock("2026-01-01T10:00:00.000Z");
  const events = new InMemoryEventRepository([
    anEvent()
      .withTiers([aTier().withRemaining(10).build()])
      .build(),
  ]);
  const store = new InMemoryHoldStore(clock);
  store.seed(TIER, 10);
  const mirror = new InMemoryHoldRepository();
  const create = new CreateHoldUseCase(
    events,
    store,
    mirror,
    clock,
    new FixedTokenGenerator([HELD, OTHER_HELD]),
    120_000,
  );
  await create.execute({ eventId: DEFAULT_EVENT_ID, tierId: TIER, qty: 2 });
  await create.execute({ eventId: DEFAULT_EVENT_ID, tierId: TIER, qty: 2 });
  clock.advance(30_000);
  const orders = new InMemoryOrderRepository(mirror);
  const idempotency = new InMemoryIdempotencyStore();
  lines = [];
  app = buildServer({
    logger: pino({ level: "info" }, { write: (line: string) => void lines.push(line) }),
    events: unusedEventController(),
    holds: unusedHoldController(),
    stats: unusedStatsController(),
    admin: unusedAdminController(),
    orders: new OrderController(
      new ConfirmOrderUseCase(
        events,
        store,
        orders,
        clock,
        new FixedTokenGenerator([
          "22222222-2222-4222-8222-000000000001",
          "22222222-2222-4222-8222-000000000002",
        ]),
      ),
    ),
    idempotency,
    checks: { postgres: ok, redis: ok },
  });
  return { app, store, orders, idempotency };
}

// Every request carries a key (the schema requires it); a fresh one unless
// the test is about reusing it.
function post(
  app: FastifyInstance,
  payload: Record<string, string>,
  key: string = randomUUID(),
): Promise<{ statusCode: number; headers: Record<string, unknown>; json<T = unknown>(): T }> {
  return app.inject({
    method: "POST",
    url: "/orders",
    headers: { "idempotency-key": key },
    payload,
  });
}

afterEach(async () => {
  await app.close();
});

const body = { holdToken: HELD, email: "hanna@example.com" };

describe("POST /orders", () => {
  it("answers 201 with the order: the total, the items at the tier's price, the instant", async () => {
    const { app } = await server();

    const response = await post(app, body);

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      orderId: "22222222-2222-4222-8222-000000000001",
      holdToken: HELD,
      email: "hanna@example.com",
      totalCents: 4000,
      items: [{ tierId: TIER, qty: 2, unitPriceCents: 2000 }],
      createdAt: "2026-01-01T10:00:30.000Z",
    });
  });

  it("carries the Idempotency-Key header into the order", async () => {
    const { app, orders } = await server();

    const response = await post(app, body, "client-key-1");

    expect(response.statusCode).toBe(201);
    expect(orders.saved(orderId("22222222-2222-4222-8222-000000000001"))?.idempotencyKey).toBe(
      "client-key-1",
    );
  });

  it("answers 410 GONE, not 404, for a token with no hold behind it", async () => {
    const { app } = await server();

    const response = await post(app, {
      ...body,
      holdToken: "11111111-1111-4111-8111-aaaaaaaaaaa9",
    });

    expect(response.statusCode).toBe(410);
    expect(response.json<ErrorDto>()).toMatchObject({ error: { code: "GONE" } });
  });

  it("answers 410 for the second confirm of the same hold, with one order", async () => {
    const { app, orders } = await server();

    const first = await post(app, body);
    const second = await post(app, body);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(410);
    expect(orders.size).toBe(1);
  });

  it("answers 409 CONFLICT from the constraint for a reused key on a different hold when the Redis layer has forgotten the key — and that hold is gone, with no order", async () => {
    // The window ADR 0007 names, and the Redis layer (TB-030) normally
    // closes with a 422 before any use case runs. Bypassed here — the key
    // dropped, as an eviction or a FLUSHDB would — the constraint is the
    // truth behind it: the consume happened, the order was refused.
    const { app, store, orders, idempotency } = await server();
    await post(app, body, "k");
    await idempotency.abandon("k");

    const reused = await post(app, { ...body, holdToken: OTHER_HELD }, "k");

    expect(reused.statusCode).toBe(409);
    expect(reused.json<ErrorDto>()).toMatchObject({ error: { code: "CONFLICT" } });
    expect(orders.size).toBe(1);
    expect(await store.find(holdToken(OTHER_HELD))).toBeNull();
  });

  it.each([
    ["a malformed token", { ...body, holdToken: "nope" }, { "idempotency-key": "k" }],
    ["an address that is not an email", { ...body, email: "hanna" }, { "idempotency-key": "k" }],
    ["a key over 200 characters", body, { "idempotency-key": "k".repeat(201) }],
    ["a missing key", body, {}],
  ])("answers 400 VALIDATION for %s, before any use case runs", async (_what, payload, headers) => {
    const { app, orders } = await server();

    const response = await app.inject({ method: "POST", url: "/orders", headers, payload });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorDto>()).toMatchObject({ error: { code: "VALIDATION" } });
    expect(orders.size).toBe(0);
  });

  it("logs neither the email nor the idempotency key at info", async () => {
    const { app } = await server();

    await post(app, body, "secret-key-value");

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain("hanna@example.com");
    expect(lines.join("\n")).not.toContain("secret-key-value");
  });
});
