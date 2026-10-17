import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type {
  BeginOutcome,
  IdempotencyStore,
  StoredResponse,
} from "../../application/ports/IdempotencyStore.js";
import { keys } from "./keys.js";
import { within } from "./within.js";

// A day, as the delivery plan says: the same request, for the same day,
// gets the same answer. The claim lives as long as the answer would —
// a request that claims and then dies (the process, not the handler) holds
// its key for a day; the client's way out is a new key (ADR 0008).
const TTL_SECONDS = 86_400;
// The write path's deadline (RedisHoldStore's), for the same reason: a
// claim that cannot be made in time fails the request, never queues it.
const COMMAND_DEADLINE_MS = 1_000;

type Stored =
  | { state: "in-progress"; fingerprint: string }
  | { state: "done"; fingerprint: string; status: number; body: string };

// One key, one JSON string, written twice: the claim with SET NX EX, the
// answer with SET EX — never a bare SET, which would drop the TTL and make
// the answer immortal (docs/NOTES.md § TB-019a).
export class RedisIdempotencyStore implements IdempotencyStore {
  constructor(
    private readonly redis: Redis,
    private readonly log: Logger,
  ) {}

  async begin(key: string, fingerprint: string): Promise<BeginOutcome> {
    this.requireReady("claim an idempotency key");
    const claim: Stored = { state: "in-progress", fingerprint };
    const won = await within(
      this.redis.set(keys.idempotency(key), JSON.stringify(claim), "EX", TTL_SECONDS, "NX"),
      COMMAND_DEADLINE_MS,
      "idempotency claim",
    );
    if (won === "OK") return { outcome: "won" };
    // Someone claimed it: either still working, or done. A key that
    // expired between the two commands reads as "in progress" — the client
    // retries and wins next time; a rare, harmless answer.
    const raw = await within(
      this.redis.get(keys.idempotency(key)),
      COMMAND_DEADLINE_MS,
      "idempotency lookup",
    );
    const stored = parse(raw);
    if (stored === null) return { outcome: "in-progress" };
    if (stored.fingerprint !== fingerprint) return { outcome: "mismatch" };
    if (stored.state === "in-progress") return { outcome: "in-progress" };
    return { outcome: "replay", response: { status: stored.status, body: stored.body } };
  }

  async complete(key: string, fingerprint: string, response: StoredResponse): Promise<void> {
    const done: Stored = { state: "done", fingerprint, ...response };
    await within(
      this.redis.set(keys.idempotency(key), JSON.stringify(done), "EX", TTL_SECONDS),
      COMMAND_DEADLINE_MS,
      "idempotency store",
    );
  }

  async abandon(key: string): Promise<void> {
    await within(this.redis.del(keys.idempotency(key)), COMMAND_DEADLINE_MS, "idempotency abandon");
  }

  // Orders fail closed: a store that cannot be reached is an error, never a
  // request that runs without a claim.
  private requireReady(operation: string): void {
    if (this.redis.status !== "ready") {
      throw new Error(`redis is ${this.redis.status}; cannot ${operation}`);
    }
  }
}

// Only this adapter writes the value, so a shape it does not recognise is a
// bug worth a warn — and worth treating as "someone is working on it"
// rather than running the use case a second time.
function parse(raw: string | null): Stored | null {
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (
    typeof value !== "object" ||
    value === null ||
    !("state" in value) ||
    !("fingerprint" in value)
  ) {
    return null;
  }
  if (typeof value.fingerprint !== "string") return null;
  if (value.state === "in-progress")
    return { state: "in-progress", fingerprint: value.fingerprint };
  if (
    value.state === "done" &&
    "status" in value &&
    typeof value.status === "number" &&
    "body" in value &&
    typeof value.body === "string"
  ) {
    return {
      state: "done",
      fingerprint: value.fingerprint,
      status: value.status,
      body: value.body,
    };
  }
  return null;
}
