import { Redis } from "ioredis";
import type { Logger } from "pino";

// The one Redis connection, created by the composition root and handed to
// the adapters that need it. Everything here is lifecycle: ioredis is an
// EventEmitter, and an "error" event with no listener terminates the
// process — the error listener below is what keeps the API alive while
// Redis is gone, and the default retryStrategy (min(times × 10, 1000) ms,
// forever) is what brings it back without a restart. Commands issued while
// disconnected wait in ioredis's offline queue (its default) rather than
// failing at once; TB-039 decides per endpoint what a down Redis means.
export function createRedisClient(url: string, log: Logger): Redis {
  const client = new Redis(url, { lazyConnect: false });
  client.on("connect", () => log.info("redis connected"));
  client.on("ready", () => log.info("redis ready"));
  client.on("error", (err: Error) => log.error({ err }, "redis error"));
  client.on("reconnecting", (delayMs: number) => log.warn({ delayMs }, "redis reconnecting"));
  client.on("end", () => log.warn("redis connection ended"));
  return client;
}
