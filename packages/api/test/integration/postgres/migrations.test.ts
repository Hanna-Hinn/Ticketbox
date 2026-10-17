import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../../src/infrastructure/postgres/migrations.js";
import { connectToTestDatabase, resetSchema, tableNames } from "../support/database.js";

const migrationsDir = fileURLToPath(new URL("../../../../../migrations/", import.meta.url));

const MIGRATION_FILES = [
  "001_events.sql",
  "002_ticket_tiers.sql",
  "003_holds.sql",
  "004_orders.sql",
  "005_order_items.sql",
  "006_availability_indexes.sql",
  "007_orders_idempotency_key.sql",
];

let client: pg.Client;

beforeAll(async () => {
  client = await connectToTestDatabase();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await resetSchema(client);
});

async function appliedVersions(): Promise<string[]> {
  const result = await client.query<{ version: string }>(
    "SELECT version FROM schema_migrations ORDER BY applied_at, version",
  );
  return result.rows.map((row) => row.version);
}

describe("runMigrations", () => {
  it("creates every table from an empty database", async () => {
    await runMigrations(client, migrationsDir);

    expect(await tableNames(client)).toEqual([
      "events",
      "holds",
      "order_items",
      "orders",
      "schema_migrations",
      "ticket_tiers",
    ]);
  });

  it("creates the availability indexes by name", async () => {
    await runMigrations(client, migrationsDir);

    const result = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE tablename IN ('holds', 'order_items') ORDER BY indexname`,
    );

    expect(result.rows.map((row) => row.indexname)).toEqual([
      "holds_pkey",
      "holds_tier_id_status_idx",
      "order_items_pkey",
      "order_items_tier_id_idx",
    ]);
  });

  it("names the idempotency constraint and lets it admit any number of NULLs", async () => {
    await runMigrations(client, migrationsDir);
    const constraint = await client.query<{ conname: string }>(
      "SELECT conname FROM pg_constraint WHERE conname = 'orders_idempotency_key_key'",
    );
    await client.query(
      `INSERT INTO events (id, name, venue, starts_at) VALUES ('11111111-1111-4111-8111-111111111111', 'e', 'v', now())`,
    );
    await client.query(
      `INSERT INTO ticket_tiers (id, event_id, name, price_cents, total_qty) VALUES ('11111111-1111-4111-8111-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 't', 1, 1)`,
    );
    const hold = (token: string): Promise<unknown> =>
      client.query(
        `INSERT INTO holds (token, tier_id, qty, status, expires_at) VALUES ($1, '11111111-1111-4111-8111-aaaaaaaaaaaa', 1, 'converted', now())`,
        [token],
      );
    const order = (id: string, token: string, key: string | null): Promise<unknown> =>
      client.query(
        `INSERT INTO orders (id, hold_token, email, total_cents, idempotency_key) VALUES ($1, $2, 'e@x.io', 0, $3)`,
        [id, token, key],
      );
    await hold("a");
    await hold("b");
    await hold("c");
    await order("22222222-2222-4222-8222-000000000001", "a", null);
    await order("22222222-2222-4222-8222-000000000002", "b", null);

    await expect(order("22222222-2222-4222-8222-000000000003", "c", "k")).resolves.toBeDefined();
    await hold("d");
    await expect(order("22222222-2222-4222-8222-000000000004", "d", "k")).rejects.toMatchObject({
      code: "23505",
      constraint: "orders_idempotency_key_key",
    });
    expect(constraint.rows).toHaveLength(1);
  });

  it("records every applied file in schema_migrations, in filename order", async () => {
    const applied = await runMigrations(client, migrationsDir);

    expect(applied).toEqual(MIGRATION_FILES);
    expect(await appliedVersions()).toEqual(MIGRATION_FILES);
  });

  it("applies nothing and throws nothing on a second run", async () => {
    await runMigrations(client, migrationsDir);

    const applied = await runMigrations(client, migrationsDir);

    expect(applied).toEqual([]);
    expect(await appliedVersions()).toEqual(MIGRATION_FILES);
  });

  it("rolls back a migration that fails mid-file and does not record it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tb-migrations-"));
    await writeFile(
      join(dir, "001_probe.sql"),
      "CREATE TABLE probe (id int); CREATE TABLE probe (id int);",
    );

    await expect(runMigrations(client, dir)).rejects.toThrow(/already exists/);

    expect(await tableNames(client)).toEqual(["schema_migrations"]);
    expect(await appliedVersions()).toEqual([]);
  });

  it("skips an already-recorded file even when its content has changed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tb-migrations-"));
    const file = join(dir, "001_probe.sql");
    await writeFile(file, "CREATE TABLE probe_a (id int);");
    await runMigrations(client, dir);
    await writeFile(file, "CREATE TABLE probe_b (id int);");

    const applied = await runMigrations(client, dir);

    expect(applied).toEqual([]);
    expect(await tableNames(client)).toEqual(["probe_a", "schema_migrations"]);
  });
});
