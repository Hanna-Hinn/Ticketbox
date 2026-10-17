import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "./config.js";
import { runMigrations } from "../infrastructure/postgres/migrations.js";

// packages/api/src/main/ -> repo root -> migrations/
const migrationsDir = fileURLToPath(new URL("../../../../migrations/", import.meta.url));

const client = new pg.Client({ connectionString: config.DATABASE_URL });
await client.connect();
try {
  const applied = await runMigrations(client, migrationsDir);
  const summary = applied.length === 0 ? "nothing to apply" : applied.join(", ");
  process.stdout.write(`migrate: ${summary}\n`);
} finally {
  await client.end();
}
