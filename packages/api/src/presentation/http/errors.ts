import type { FastifyInstance } from "fastify";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";
import { DomainError } from "../../domain/errors/DomainError.js";
import { EventNotFound } from "../../domain/errors/EventNotFound.js";
import { TierNotFound } from "../../domain/errors/TierNotFound.js";

// The one place a domain error becomes an HTTP status. A status on the error
// itself would be HTTP knowledge in Layer 1; a table here is "mapped once".
// A DomainError not in the table is an invariant violation, i.e. a bug, and
// a bug is a 500 like any other.
const STATUS_OF: readonly (readonly [new (...args: never[]) => DomainError, number])[] = [
  [EventNotFound, 404],
  [TierNotFound, 404],
];

const INTERNAL = { error: { code: "INTERNAL", message: "internal error" } };

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.code(400).send({ error: { code: "VALIDATION", message: error.message } });
    }
    if (error instanceof DomainError) {
      const known = STATUS_OF.find(([type]) => error instanceof type);
      if (known !== undefined) {
        return reply.code(known[1]).send({ error: { code: "NOT_FOUND", message: error.message } });
      }
    }
    // Everything about the error goes to the log with the request id, and
    // nothing about it goes to the client: not the message, not the stack.
    request.log.error({ err: error }, "unhandled error");
    return reply.code(500).send(INTERNAL);
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      error: { code: "NOT_FOUND", message: `route ${request.method} ${request.url} not found` },
    }),
  );
}
