import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { CacheStats, CacheStatsReader } from "../../application/ports/CacheStatsReader.js";
import type { CacheStatsRecorder } from "./CachedEventRepository.js";
import { describeRedisError } from "./client.js";
import { keys } from "./keys.js";
import { CACHE_COMMAND_DEADLINE_MS, within } from "./within.js";

// Hit/miss counters as two INCRs (TB-019). Recording is fire-and-forget: a
// counter must never change a read's result or latency beyond the
// deadline. Reading fails open to zeros — a stats page that 500s when the
// cache is gone would be the wrong kind of visible.

export class RedisCacheStats implements CacheStatsReader, CacheStatsRecorder {
  constructor(
    private readonly redis: Redis,
    private readonly log: Logger,
  ) {}

  recordHit(): void {
    this.bump(keys.cacheStats.hits);
  }

  recordMiss(): void {
    this.bump(keys.cacheStats.misses);
  }

  async read(): Promise<CacheStats> {
    if (this.redis.status !== "ready") return { hits: 0, misses: 0 };
    try {
      const [hits, misses] = await within(
        this.redis.mget(keys.cacheStats.hits, keys.cacheStats.misses),
        CACHE_COMMAND_DEADLINE_MS,
      );
      return { hits: toCount(hits), misses: toCount(misses) };
    } catch (err: unknown) {
      this.log.warn({ err: describeRedisError(err) }, "cache stats read failed; reporting zeros");
      return { hits: 0, misses: 0 };
    }
  }

  private bump(key: string): void {
    if (this.redis.status !== "ready") return;
    void within(this.redis.incr(key), CACHE_COMMAND_DEADLINE_MS).catch((err: unknown) => {
      this.log.warn({ err: describeRedisError(err), key }, "cache counter not recorded");
    });
  }
}

function toCount(raw: string | null | undefined): number {
  const parsed = Number(raw ?? "0");
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}
