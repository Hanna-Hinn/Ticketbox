import pg from "pg";

// Integration tests own a sibling database, ticketbox_test, on the same
// server as DATABASE_URL (defaulting to the compose stack's values). They
// never touch the dev database: migration tests drop the whole schema.
const DEFAULT_DATABASE_URL = "postgresql://ticketbox:ticketbox@localhost:5432/ticketbox";
const TEST_DATABASE = "ticketbox_test";

function devDatabaseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
}

function testDatabaseUrl(): string {
  const url = new URL(devDatabaseUrl());
  url.pathname = `/${TEST_DATABASE}`;
  return url.toString();
}

// CREATE DATABASE cannot run inside a transaction and cannot target the
// database you are connected to, so this goes through the dev database.
async function ensureTestDatabase(): Promise<void> {
  const admin = new pg.Client({ connectionString: devDatabaseUrl() });
  await admin.connect();
  try {
    const found = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      TEST_DATABASE,
    ]);
    if (found.rowCount === 0) {
      await admin.query(`CREATE DATABASE ${TEST_DATABASE}`);
    }
  } finally {
    await admin.end();
  }
}

export async function connectToTestDatabase(): Promise<pg.Client> {
  await ensureTestDatabase();
  const client = new pg.Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  return client;
}

// Back to a genuinely empty database: no tables, no schema_migrations.
export async function resetSchema(client: pg.Client): Promise<void> {
  await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
}

export async function tableNames(client: pg.Client): Promise<string[]> {
  const result = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' ORDER BY table_name`,
  );
  return result.rows.map((row) => row.table_name);
}
