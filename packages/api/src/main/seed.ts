import pg from "pg";
import { config } from "./config.js";
import { seed } from "../infrastructure/postgres/seed.js";

const client = new pg.Client({ connectionString: config.DATABASE_URL });
await client.connect();
try {
  const { events, tiers } = await seed(client);
  process.stdout.write(`seed: inserted ${events} events, ${tiers} tiers\n`);
} finally {
  await client.end();
}
