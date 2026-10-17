import { randomUUID } from "node:crypto";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { EventController } from "./controllers/EventController.js";
import { registerErrorHandling } from "./errors.js";
import { registerEventRoutes } from "./routes/events.js";
import {
  DEFAULT_CHECK_TIMEOUT_MS,
  registerHealthRoutes,
  type DependencyChecks,
} from "./routes/health.js";

export interface ServerDeps {
  readonly logger: FastifyBaseLogger;
  readonly events: EventController;
  readonly checks: DependencyChecks;
  // Only a test has a reason to set this: a tiny real bound beats a 2 s wait.
  readonly healthCheckTimeoutMs?: number;
}

const CORRELATION_HEADER = "x-correlation-id";

// Everything the server needs arrives through `deps`; nothing here knows
// what is behind a controller or where the logger writes.
export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    loggerInstance: deps.logger,
    // The correlation id is Fastify's request id: taken from the client's
    // header when present, generated otherwise, on every log line as reqId.
    requestIdHeader: CORRELATION_HEADER,
    genReqId: () => randomUUID(),
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
  registerHealthRoutes(app, deps.checks, deps.healthCheckTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS);
  return app;
}
