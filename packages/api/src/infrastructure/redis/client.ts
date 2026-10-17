import { Redis } from "ioredis";
import type { Logger } from "pino";

// The one Redis connection, created by the composition root and handed to
// the adapters that need it. Everything here is lifecycle. ioredis never
// throws an unlistened "error" (it console.errors it and carries on); the
// listener below exists so the line reaches pino, structured, under this
// component. What keeps the API usable while Redis is gone is ioredis's
// default retryStrategy (min(2^(n-1) × 50 ms, 5 s) + up to 200 ms jitter,
// forever): the client reconnects without a restart. Commands issued while
// disconnected wait in the offline queue (default on) rather than failing
// at once; TB-039 decides per endpoint what a down Redis means.
export function createRedisClient(url: string, log: Logger): Redis {
  const client = new Redis(url);
  client.on("connect", () => log.info("redis connected"));
  client.on("ready", () => log.info("redis ready"));
  client.on("error", (err: Error) => log.error({ err: describeRedisError(err) }, "redis error"));
  client.on("reconnecting", (delayMs: number) => log.warn({ delayMs }, "redis reconnecting"));
  client.on("end", () => log.info("redis connection ended"));
  return client;
}

// A reply error carries { name, args } of the failed command; for AUTH the
// args are the password. Log the error, not its arguments. A refused
// connection to a host with two address families is an AggregateError whose
// own message is empty and whose reasons sit in `errors` — keep those.
export function describeRedisError(err: unknown): {
  name: string;
  message: string;
  stack: string | undefined;
  causes?: string[];
} {
  if (!(err instanceof Error)) return { name: "unknown", message: String(err), stack: undefined };
  const causes =
    err instanceof AggregateError
      ? err.errors.map((cause) => (cause instanceof Error ? cause.message : String(cause)))
      : undefined;
  return {
    name: err.name,
    message: err.message,
    stack: err.stack,
    ...(causes === undefined ? {} : { causes }),
  };
}

// quit() waits for pending replies, which is right while Redis answers.
// While it is unreachable, every /health ping since the last "ready" sits in
// the offline queue and quit() queues behind them; ioredis settles them only
// after maxRetriesPerRequest reconnects (measured: 74 s, then quit() rejects
// and the reconnect timer keeps the event loop alive). A shutdown cannot wait
// on a server that is not there: disconnect() clears the reconnect timer; a
// queued command either rejects (a socket was in flight) or stays pending
// (none was) — either way its caller's own deadline (pingWithin, for
// /health) has already settled it. After disconnect() during a reconnect the
// status still reads "reconnecting" — the socket was already gone, so no
// close event follows — but nothing keeps the event loop alive (measured:
// the process exits).
export async function closeRedisClient(client: Redis): Promise<void> {
  if (client.status !== "ready") {
    client.disconnect();
    return;
  }
  await client.quit();
}
