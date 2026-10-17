import { randomUUID } from "node:crypto";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { EventController } from "./controllers/EventController.js";
import type { HoldController } from "./controllers/HoldController.js";
import type { OrderController } from "./controllers/OrderController.js";
import type { IdempotencyStore } from "../../application/ports/IdempotencyStore.js";
import type { AdminController } from "./controllers/AdminController.js";
import type { StatsController } from "./controllers/StatsController.js";
import { registerErrorHandling } from "./errors.js";
import { idempotencyHooks } from "./idempotency.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerHoldRoutes } from "./routes/holds.js";
import { registerOrderRoutes } from "./routes/orders.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerStatsRoutes } from "./routes/stats.js";
import {
  DEFAULT_CHECK_TIMEOUT_MS,
  registerHealthRoutes,
  type DependencyChecks,
} from "./routes/health.js";

export interface ServerDeps {
  readonly logger: FastifyBaseLogger;
  readonly events: EventController;
  readonly holds: HoldController;
  readonly orders: OrderController;
  readonly idempotency: IdempotencyStore;
  readonly stats: StatsController;
  readonly admin: AdminController;
  readonly checks: DependencyChecks;
  // Only a test has a reason to set this: a tiny real bound beats a 2 s wait.
  readonly healthCheckTimeoutMs?: number;
}

const CORRELATION_HEADER = "x-correlation-id";
// A client id is a courtesy, not a contract: anything outside this shape is
// silently replaced, so a 5 kB header cannot become a 5 kB field on every
// log line of the request.
const CORRELATION_ID = /^[A-Za-z0-9_-]{1,64}$/;

// Everything the server needs arrives through `deps`; nothing here knows
// what is behind a controller or where the logger writes.
export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    loggerInstance: deps.logger,
    // The correlation id is Fastify's request id: the client's header when
    // it is well-formed, generated otherwise, on every log line as reqId.
    // requestIdHeader is off because Fastify would use the header unchecked.
    requestIdHeader: false,
    genReqId: (req) => {
      const supplied = req.headers[CORRELATION_HEADER];
      return typeof supplied === "string" && CORRELATION_ID.test(supplied)
        ? supplied
        : randomUUID();
    },
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.addHook("onSend", (request, reply, payload, done) => {
    reply.header(CORRELATION_HEADER, request.id);
    reply.header("x-response-time", reply.elapsedTime.toFixed(2));
    done(null, payload);
  });

  registerErrorHandling(app);
  registerEventRoutes(app, deps.events);
  registerHoldRoutes(app, deps.holds);
  registerOrderRoutes(app, deps.orders, idempotencyHooks(deps.idempotency));
  registerStatsRoutes(app, deps.stats);
  registerAdminRoutes(app, deps.admin);
  registerHealthRoutes(app, deps.checks, deps.healthCheckTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS);
  return app;
}
