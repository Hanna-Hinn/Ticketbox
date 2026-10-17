import type { FastifyInstance } from "fastify";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";
import { DomainError } from "../../domain/errors/DomainError.js";
import { EventNotFound } from "../../domain/errors/EventNotFound.js";
import { HoldNotFound } from "../../domain/errors/HoldNotFound.js";
import { InsufficientInventory } from "../../domain/errors/InsufficientInventory.js";
import { InvalidQuantity } from "../../domain/errors/InvalidQuantity.js";
import { TierNotFound } from "../../domain/errors/TierNotFound.js";
import type { ErrorDto } from "../dto/errors.js";

// The one place a domain error becomes an HTTP status. A status on the error
// itself would be HTTP knowledge in Layer 1; a table here is "mapped once".
// A DomainError not in the table is an invariant violation, i.e. a bug, and
// a bug is a 500 like any other. Keyed on the exact class: a subclass is a
// different error with its own row.
const STATUS_OF: ReadonlyMap<unknown, { status: number; code: string }> = new Map<
  unknown,
  { status: number; code: string }
>([
  [EventNotFound, { status: 404, code: "NOT_FOUND" }],
  [TierNotFound, { status: 404, code: "NOT_FOUND" }],
  [HoldNotFound, { status: 404, code: "NOT_FOUND" }],
  // The entity owns the quantity bound (TB-008 decision 9); a client value
  // outside it is the client's fault, the same 400 a schema failure gets.
  [InvalidQuantity, { status: 400, code: "VALIDATION" }],
  // 409: the request was well-formed and the tier exists; the state refused it.
  [InsufficientInventory, { status: 409, code: "INSUFFICIENT" }],
]);

function envelope(code: string, message: string): ErrorDto {
  return { error: { code, message } };
}

const INTERNAL = envelope("INTERNAL", "internal error");

// Fastify hands the handler `unknown`; its own errors are @fastify/error
// instances carrying a statusCode and a message.
function isClientError(error: unknown): error is { statusCode: number; message: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number" &&
    error.statusCode >= 400 &&
    error.statusCode < 500 &&
    "message" in error &&
    typeof error.message === "string"
  );
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.code(400).send(envelope("VALIDATION", error.message));
    }
    if (error instanceof DomainError) {
      const known = STATUS_OF.get(error.constructor);
      if (known !== undefined) {
        return reply.code(known.status).send(envelope(known.code, error.message));
      }
    }
    // Fastify's own client-side failures (bad JSON, unsupported media type,
    // body too large) carry a 4xx statusCode and are the client's fault. A
    // custom handler has to read it: only the default handler applies it.
    if (isClientError(error)) {
      return reply.code(error.statusCode).send(envelope("BAD_REQUEST", error.message));
    }
    // Everything about the error goes to the log with the request id, and
    // nothing about it goes to the client: not the message, not the stack.
    request.log.error({ err: error }, "unhandled error");
    return reply.code(500).send(INTERNAL);
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send(envelope("NOT_FOUND", "route not found")),
  );
}
