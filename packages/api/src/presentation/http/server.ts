import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { EventController } from "./controllers/EventController.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerHealthRoutes, type DependencyChecks } from "./routes/health.js";

export interface ServerDeps {
  readonly events: EventController;
  readonly checks: DependencyChecks;
}

const START = Symbol("requestStart");

// Everything the server needs arrives through `deps`; nothing here knows
// what is behind a controller. Logging, the correlation id and the error
// handler are TB-012's.
export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorateRequest(START, 0n);
  app.addHook("onRequest", (request, _reply, done) => {
    request[START] = process.hrtime.bigint();
    done();
  });
  app.addHook("onSend", (request, reply, payload, done) => {
    const elapsedMs = Number(process.hrtime.bigint() - request[START]) / 1_000_000;
    reply.header("x-response-time", elapsedMs.toFixed(2));
    done(null, payload);
  });

  registerEventRoutes(app, deps.events);
  registerHealthRoutes(app, deps.checks);
  return app;
}

declare module "fastify" {
  interface FastifyRequest {
    [START]: bigint;
  }
}
