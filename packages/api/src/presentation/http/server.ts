import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { EventController } from "./controllers/EventController.js";
import { registerEventRoutes } from "./routes/events.js";
import {
  DEFAULT_CHECK_TIMEOUT_MS,
  registerHealthRoutes,
  type DependencyChecks,
} from "./routes/health.js";

export interface ServerDeps {
  readonly events: EventController;
  readonly checks: DependencyChecks;
  // Only a test has a reason to set this: a tiny real bound beats a 2 s wait.
  readonly healthCheckTimeoutMs?: number;
}

// Everything the server needs arrives through `deps`; nothing here knows
// what is behind a controller. Logging, the correlation id and the error
// handler are TB-012's.
export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // TODO(tech-debt): replace with reply.elapsedTime once TB-012 turns the
  // logger on — Fastify only records a reply start time when a logger, an
  // onResponse hook or a timeout exists, so under logger: false it reads 0.
  const startedAt = new WeakMap<FastifyRequest, bigint>();
  app.addHook("onRequest", (request, _reply, done) => {
    startedAt.set(request, process.hrtime.bigint());
    done();
  });
  app.addHook("onSend", (request, reply, payload, done) => {
    const start = startedAt.get(request);
    if (start !== undefined) {
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      reply.header("x-response-time", elapsedMs.toFixed(2));
    }
    done(null, payload);
  });

  registerEventRoutes(app, deps.events);
  registerHealthRoutes(app, deps.checks, deps.healthCheckTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS);
  return app;
}
