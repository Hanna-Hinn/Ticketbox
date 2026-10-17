import type { FastifyInstance } from "fastify";
import pino from "pino";
import { GetEventAvailabilityUseCase } from "../application/use-cases/GetEventAvailability.js";
import { ListUpcomingEventsUseCase } from "../application/use-cases/ListUpcomingEvents.js";
import { PgEventRepository } from "../infrastructure/postgres/PgEventRepository.js";
import { createPool } from "../infrastructure/postgres/pool.js";
import { createRedisClient } from "../infrastructure/redis/client.js";
import { SystemClock } from "../infrastructure/system/SystemClock.js";
import { UnconfiguredHoldStore } from "../infrastructure/system/UnconfiguredHoldStore.js";
import { EventController } from "../presentation/http/controllers/EventController.js";
import { buildServer } from "../presentation/http/server.js";
import type { Config } from "./config.js";

export interface System {
  readonly app: FastifyInstance;
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
  // Connects now and reconnects forever; its own error listener keeps the
  // process alive while Redis is gone (TB-017). Nothing reads it yet.
  const redis = createRedisClient(config.REDIS_URL, log.child({ component: "redis" }));

  // Ports → adapters
  const events = new PgEventRepository(pool); // EventRepository
  const holds = new UnconfiguredHoldStore(); // HoldStore, until TB-022
  const clock = new SystemClock(); // Clock

  // Use cases
  const listUpcoming = new ListUpcomingEventsUseCase(events, clock);
  const getAvailability = new GetEventAvailabilityUseCase(events, holds);

  // HTTP
  const controller = new EventController(listUpcoming, getAvailability);
  const checks = {
    postgres: async (): Promise<void> => {
      await pool.query("SELECT 1");
    },
    redis: async (): Promise<void> => {
      await redis.ping();
    },
  };
  const app = buildServer({ logger: log, events: controller, checks });

  // Memoised: pool.end() throws if called twice, and a supervisor's
  // SIGINT-then-SIGTERM is two calls. quit() waits for pending replies;
  // disconnect() would not.
  let closing: Promise<void> | undefined;
  return {
    app,
    close: () => {
      closing ??= (async () => {
        await app.close();
        await Promise.all([pool.end(), redis.quit()]);
      })();
      return closing;
    },
  };
}
