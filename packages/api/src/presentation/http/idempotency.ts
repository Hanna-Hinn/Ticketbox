import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { IdempotencyStore } from "../../application/ports/IdempotencyStore.js";
import { envelope } from "./errors.js";

export const IDEMPOTENCY_HEADER = "idempotency-key";
export const REPLAYED_HEADER = "idempotency-replayed";

// Two route-scoped hooks around one handler (TB-030). Before: claim the key
// for this body, or answer from what became of it. After: store what the
// handler — or the error handler — answered, so the next request with the
// key gets the same bytes back; a 500 is ours, not the request's, and is
// not remembered. The handler in between knows nothing about any of this.
export interface IdempotencyHooks {
  preHandler(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  onSend(request: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown>;
}

interface Claim {
  readonly key: string;
  readonly fingerprint: string;
}

export function idempotencyHooks(store: IdempotencyStore): IdempotencyHooks {
  // The winner's claim, carried from one hook to the other on the request.
  const claims = new WeakMap<FastifyRequest, Claim>();

  return {
    async preHandler(request, reply) {
      // The schema already required and bounded the header, and accepted
      // the body: the fingerprint is of what the handler will see.
      const key = headerValue(request.headers[IDEMPOTENCY_HEADER]);
      const fingerprint = fingerprintOf(request.body);
      const begun = await store.begin(key, fingerprint);
      switch (begun.outcome) {
        case "won":
          claims.set(request, { key, fingerprint });
          return undefined;
        case "in-progress":
          return reply
            .code(409)
            .send(envelope("IN_PROGRESS", "a request with this idempotency key is in progress"));
        case "mismatch":
          return reply
            .code(422)
            .send(envelope("MISMATCH", "this idempotency key was used with a different request"));
        case "replay":
          return reply
            .code(begun.response.status)
            .header(REPLAYED_HEADER, "true")
            .header("content-type", "application/json; charset=utf-8")
            .send(begun.response.body);
      }
    },

    async onSend(request, reply, payload) {
      const claim = claims.get(request);
      if (claim === undefined) return payload;
      try {
        if (reply.statusCode >= 500 || typeof payload !== "string") {
          await store.abandon(claim.key);
        } else {
          await store.complete(claim.key, claim.fingerprint, {
            status: reply.statusCode,
            body: payload,
          });
        }
      } catch (err: unknown) {
        // The answer is already going out; a claim that cannot be completed
        // must not stay a claim for a day.
        request.log.warn({ err }, "idempotency answer not stored; abandoning the claim");
        await store.abandon(claim.key).catch(() => undefined);
      }
      return payload;
    },
  };
}

function headerValue(value: string | string[] | undefined): string {
  if (typeof value === "string") return value;
  // The schema rejects an absent header; a repeated one is its first value.
  const first = value?.[0];
  if (first === undefined)
    throw new Error("idempotency hooks ran without the header the schema requires");
  return first;
}

// Sorted keys, so two JSON spellings of one request fingerprint the same.
export function fingerprintOf(body: unknown): string {
  return createHash("sha256").update(canonical(body)).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
