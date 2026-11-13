/*
 * Copy everything from the SQLite file into PostgreSQL, once.
 *
 *   DATABASE_URL=postgres://user:pass@host:5432/dbname node src/migrate-to-postgres.js
 *
 * The SQLite file is left untouched, so you can go back if anything looks wrong.
 */
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { connectStore, store, ROOT } from './store.js';
import { createSchema } from './schema.js';
import { loadEnv } from './env.js';

loadEnv(ROOT);
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Donne d abord l adresse PostgreSQL, par exemple:\n  DATABASE_URL=postgres://postgres:motdepasse@localhost:5432/marhba node src/migrate-to-postgres.js');
  process.exit(1);
}
const sqlitePath = process.env.SQLITE_PATH || join(ROOT, 'data', 'app.db');
if (!existsSync(sqlitePath)) { console.error(`Fichier SQLite introuvable: ${sqlitePath}`); process.exit(1); }

const source = new DatabaseSync(sqlitePath);
const connection = await connectStore();
if (connection.driver !== 'postgres') { console.error('DATABASE_URL ne pointe pas vers PostgreSQL.'); process.exit(1); }
await createSchema();

const TABLES = ['users', 'restaurants', 'categories', 'products', 'option_groups', 'product_options',
  'orders', 'order_items', 'order_item_options', 'order_status_history', 'refunds', 'audit_logs'];

let total = 0;
for (const table of TABLES) {
  let rows = [];
  try { rows = source.prepare(`SELECT * FROM ${table} ORDER BY id`).all(); } catch { continue; }
  if (!rows.length) { console.log(`  ${table}: vide`); continue; }
  const columns = Object.keys(rows[0]);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(',');
  for (const row of rows) {
    await store.run(
      `INSERT INTO ${table} (${columns.join(',')}) OVERRIDING SYSTEM VALUE VALUES (${placeholders})`,
      columns.map((c) => row[c])
    );
  }
  // Keep the identity counter ahead of the copied ids.
  await store.run(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), (SELECT COALESCE(MAX(id),1) FROM ${table}))`);
  console.log(`  ${table}: ${rows.length} lignes`);
  total += rows.length;
}

console.log(`\nTermine — ${total} lignes copiees vers PostgreSQL.`);
source.close();
await store.close();
