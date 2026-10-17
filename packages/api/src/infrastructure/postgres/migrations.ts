import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Client } from "pg";

// Each migration runs in its own transaction. Postgres DDL is transactional,
// so a file that fails halfway leaves neither a half-built table nor a
// recorded version -- the next run simply re-applies it from scratch.
export async function runMigrations(client: Client, dir: string): Promise<string[]> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    text        PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );

  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied = await client.query<{ version: string }>("SELECT version FROM schema_migrations");
  const done = new Set(applied.rows.map((row) => row.version));

  const appliedNow: string[] = [];
  for (const file of files.filter((f) => !done.has(f))) {
    const sql = await readFile(join(dir, file), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    appliedNow.push(file);
  }
  return appliedNow;
}
