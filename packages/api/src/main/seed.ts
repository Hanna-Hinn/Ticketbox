import { Redis } from "ioredis";
import pg from "pg";
import { config } from "./config.js";
import { seed, SEED_EVENTS } from "../infrastructure/postgres/seed.js";
import { seedLiveCounters } from "../infrastructure/redis/seedLiveCounters.js";

// Both stores: the rows, then the live counters the write path decides
// against (TB-025). Redis is opened first, so a Redis that is down fails the
// seed before a single row is written, and says why.
const redis = new Redis(config.REDIS_URL, { lazyConnect: true });
let cause: Error | undefined;
redis.on("error", (err: Error) => {
  cause ??= err;
});
try {
  await redis.connect();
} catch {
  redis.disconnect();
  throw new Error(
    `seed: redis is unreachable at ${config.REDIS_URL}: ${cause?.message ?? "connection closed"}`,
  );
}

const client = new pg.Client({ connectionString: config.DATABASE_URL });
try {
  await client.connect();
  const { events, tiers } = await seed(client);
  process.stdout.write(`seed: inserted ${events} events, ${tiers} tiers\n`);
  const counters = await seedLiveCounters(
    redis,
    SEED_EVENTS.flatMap((event) => event.tiers),
  );
  process.stdout.write(`seed: wrote ${counters} live counters\n`);
} finally {
  await client.end();
  await redis.quit();
}
