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
