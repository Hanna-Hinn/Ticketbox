import type { FastifyInstance } from "fastify";
import pino from "pino";
import { CreateHoldUseCase } from "../application/use-cases/CreateHold.js";
import { GetCacheStatsUseCase } from "../application/use-cases/GetCacheStats.js";
import { GetHoldUseCase } from "../application/use-cases/GetHold.js";
import { GetEventAvailabilityUseCase } from "../application/use-cases/GetEventAvailability.js";
import { ListUpcomingEventsUseCase } from "../application/use-cases/ListUpcomingEvents.js";
import { ReconcileEventUseCase } from "../application/use-cases/ReconcileEvent.js";
import { ReleaseExpiredHoldsUseCase } from "../application/use-cases/ReleaseExpiredHolds.js";
import { ReleaseHoldUseCase } from "../application/use-cases/ReleaseHold.js";
import { PgEventRepository } from "../infrastructure/postgres/PgEventRepository.js";
import { PgHoldRepository } from "../infrastructure/postgres/PgHoldRepository.js";
import { createPool } from "../infrastructure/postgres/pool.js";
import { CachedEventRepository } from "../infrastructure/redis/CachedEventRepository.js";
import { RedisCacheStats } from "../infrastructure/redis/RedisCacheStats.js";
import { RedisHoldStore } from "../infrastructure/redis/RedisHoldStore.js";
import { closeRedisClient, createRedisClient } from "../infrastructure/redis/client.js";
import { SystemClock } from "../infrastructure/system/SystemClock.js";
import { UuidTokenGenerator } from "../infrastructure/system/UuidTokenGenerator.js";
import { AdminController } from "../presentation/http/controllers/AdminController.js";
import { EventController } from "../presentation/http/controllers/EventController.js";
import { HoldController } from "../presentation/http/controllers/HoldController.js";
import { StatsController } from "../presentation/http/controllers/StatsController.js";
import { buildServer } from "../presentation/http/server.js";
import type { Config } from "./config.js";

export interface System {
  readonly app: FastifyInstance;
  /** One sweep of the expired holds; the worker (worker/sweeper.ts) runs it every 5 s (TB-026). */
  readonly sweeper: ReleaseExpiredHoldsUseCase;
  close(): Promise<void>;
}

// The map of the system. The only file that may `new` a concrete adapter;
// read it top to bottom.
export function compose(config: Config): System {
  const log = pino({ level: config.LOG_LEVEL });

  // Drivers
  const pool = createPool(config.DATABASE_URL);
  // An idle client losing its connection makes the pool emit "error";
  // unhandled, that would terminate the process (TB-010).
  pool.on("error", (err) => log.error({ err }, "idle postgres client errored"));
  // Connects now and reconnects forever; nothing reads it yet (TB-017).
  const redis = createRedisClient(config.REDIS_URL, log.child({ component: "redis" }));

  // Ports → adapters
  // EventRepository: Postgres computes, Redis remembers the answer for 300 s
  // (TB-018). Only this line knows there is a cache.
  const cacheStats = new RedisCacheStats(redis, log.child({ component: "cache-stats" }));
  const pgEvents = new PgEventRepository(pool);
  const events = new CachedEventRepository(
    pgEvents,
    redis,
    cacheStats, // CacheStatsRecorder
    log.child({ component: "event-cache" }),
  );
  // HoldStore: the live counters and holds, create_hold.lua behind reserve
  // (TB-022). The counters are written by `pnpm seed` (seedLiveCounters) for
  // dev and CI; rebuilding them from Postgres is reconciliation (TB-027).
  const holds = new RedisHoldStore(redis, log.child({ component: "hold-store" }));
  // HoldRepository: the audit row, written after the store decides (TB-024).
  const holdMirror = new PgHoldRepository(pool);
  const clock = new SystemClock(); // Clock
  const tokens = new UuidTokenGenerator(); // TokenGenerator

  // Use cases
  const listUpcoming = new ListUpcomingEventsUseCase(events, clock);
  const getAvailability = new GetEventAvailabilityUseCase(events, holds);
  const getCacheStats = new GetCacheStatsUseCase(cacheStats); // CacheStatsReader
  const createHold = new CreateHoldUseCase(
    events,
    holds,
    holdMirror,
    clock,
    tokens,
    config.HOLD_TTL_MS,
  );
  const getHold = new GetHoldUseCase(holds, clock);
  const releaseHold = new ReleaseHoldUseCase(holds, holdMirror);
  const sweeper = new ReleaseExpiredHoldsUseCase(holds, holdMirror, clock);
  // Reconcile reads Postgres, never the cache: a five-minute-old computed
  // count written over the live counter would be reconciliation in reverse.
  const reconcile = new ReconcileEventUseCase(pgEvents, holds, holdMirror); // InventoryRepair

  // HTTP
  const controller = new EventController(listUpcoming, getAvailability);
  const holdController = new HoldController(createHold, getHold, releaseHold);
  const stats = new StatsController(getCacheStats);
  const admin = new AdminController(reconcile);
  const checks = {
    postgres: async (): Promise<void> => {
      await pool.query("SELECT 1");
    },
    redis: async (): Promise<void> => {
      await redis.ping();
    },
  };
  const app = buildServer({
    logger: log,
    events: controller,
    holds: holdController,
    stats,
    admin,
    checks,
  });

  // Memoised: pool.end() throws if called twice, and a supervisor's
  // SIGINT-then-SIGTERM is two calls.
  let closing: Promise<void> | undefined;
  return {
    app,
    sweeper,
    close: () => {
      closing ??= (async () => {
        await app.close();
        await Promise.all([pool.end(), closeRedisClient(redis)]);
      })();
      return closing;
    },
  };
}
