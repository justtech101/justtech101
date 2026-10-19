// Applies migrations/*.sql in order. `--reset` drops everything first so the
// schema can be rebuilt from scratch.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnv } from "./core/config.js";
import { MIGRATIONS_DIR } from "./core/paths.js";
import { createPool, type Db } from "./core/store.js";

export async function migrate(db: Db, opts: { reset?: boolean } = {}): Promise<string[]> {
  if (opts.reset) {
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  }
  await db.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  );
  const { rows } = await db.query("SELECT name FROM schema_migrations");
  const done = new Set(rows.map((r) => r.name));
  const applied: string[] = [];
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(file)) continue;
    const sql = readFileSync(resolve(MIGRATIONS_DIR, file), "utf8");
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      applied.push(file);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
  return applied;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = loadEnv();
  const db = createPool(env.DATABASE_URL, env.DATABASE_SSL);
  migrate(db, { reset: process.argv.includes("--reset") })
    .then((applied) => {
      console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Schema up to date.");
      return db.end();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
