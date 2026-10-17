import { Redis } from "ioredis";
import pg from "pg";
import { config } from "./config.js";
import { seed, SEED_EVENTS } from "../infrastructure/postgres/seed.js";
import { seedLiveCounters } from "../infrastructure/redis/seedLiveCounters.js";
import { tierId } from "../domain/value-objects/Ids.js";

// Both stores: the rows, then the live counters the write path decides
// against (TB-025). A Redis that is down fails the seed loudly rather than
// leaving half a system seeded.
const client = new pg.Client({ connectionString: config.DATABASE_URL });
await client.connect();
try {
  const { events, tiers } = await seed(client);
  process.stdout.write(`seed: inserted ${events} events, ${tiers} tiers\n`);
} finally {
  await client.end();
}

const redis = new Redis(config.REDIS_URL, { lazyConnect: true });
await redis.connect();
try {
  const counters = await seedLiveCounters(
    redis,
    SEED_EVENTS.flatMap((event) =>
      event.tiers.map((tier) => ({ id: tierId(tier.id), totalQty: tier.totalQty })),
    ),
  );
  process.stdout.write(`seed: wrote ${counters} live counters\n`);
} finally {
  await redis.quit();
}
