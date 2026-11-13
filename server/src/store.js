/*
 * One database interface, two engines.
 *
 *   DATABASE_URL=postgres://user:pass@host:5432/dbname   -> PostgreSQL
 *   (nothing set)                                        -> SQLite file in data/app.db
 *
 * SQL is always written in PostgreSQL style ($1, $2 …); it is translated for
 * SQLite automatically. Every query goes through one lock, so a transaction
 * can never be interleaved with another request's statements.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { PgClient } from './pg-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..', '..');

let driver = null;      // 'postgres' | 'sqlite'
let pg = null;
let sqlite = null;

/* ---------------- lock: one statement (or one transaction) at a time -------- */
let chain = Promise.resolve();
function lock(fn) {
  const result = chain.then(fn, fn);
  chain = result.then(() => undefined, () => undefined);
  return result;
}

/* ---------------- $1 -> ? translation for SQLite ---------------------------- */
function toSqlite(sql, params) {
  const ordered = [];
  const text = sql.replace(/\$(\d+)/g, (_, index) => {
    ordered.push(params[Number(index) - 1]);
    return '?';
  });
  return [text, ordered];
}

const normalise = (value) => {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
};

/* ---------------- engine calls (no lock — callers take it) ------------------ */
async function exec(sql, params = []) {
  const args = params.map(normalise);
  if (driver === 'postgres') {
    const result = await pg.query(sql, args);
    return { rows: result.rows, rowCount: result.rowCount };
  }
  const [text, ordered] = toSqlite(sql, args);
  const statement = sqlite.prepare(text);
  const isRead = /^\s*(SELECT|WITH)/i.test(text) || /RETURNING/i.test(text);
  if (isRead) {
    const rows = statement.all(...ordered).map((row) => ({ ...row }));
    return { rows, rowCount: rows.length };
  }
  const info = statement.run(...ordered);
  return { rows: [], rowCount: Number(info.changes || 0) };
}

/* ---------------- public API ------------------------------------------------ */
export const store = {
  get driver() { return driver; },

  all: (sql, params) => lock(async () => (await exec(sql, params)).rows),
  get: (sql, params) => lock(async () => (await exec(sql, params)).rows[0]),
  run: (sql, params) => lock(() => exec(sql, params)),

  /** Insert and get the new id back, on either engine. */
  insert: (sql, params) => lock(async () => {
    const result = await exec(`${sql} RETURNING id`, params);
    return result.rows[0]?.id;
  }),

  /** Everything inside fn runs in one transaction, alone on the connection. */
  tx: (fn) => lock(async () => {
    await exec('BEGIN');
    try {
      const value = await fn({
        all: async (sql, params) => (await exec(sql, params)).rows,
        get: async (sql, params) => (await exec(sql, params)).rows[0],
        run: (sql, params) => exec(sql, params),
        insert: async (sql, params) => (await exec(`${sql} RETURNING id`, params)).rows[0]?.id,
      });
      await exec('COMMIT');
      return value;
    } catch (err) {
      try { await exec('ROLLBACK'); } catch { /* connection already gone */ }
      throw err;
    }
  }),

  /** Raw multi-statement DDL. */
  exec: (sql) => lock(() => exec(sql)),

  /** SQLite only: run statements directly (PRAGMA, multi-statement DDL). */
  sqliteExec: (sql) => lock(async () => { if (driver === 'sqlite') sqlite.exec(sql); }),

  /** SQLite only: the CREATE TABLE text, used to detect an old schema. */
  sqliteTableSql: (table) => lock(async () => {
    if (driver !== 'sqlite') return null;
    const row = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?").get(table);
    return row ? row.sql : null;
  }),

  /**
   * Every table the application owns, discovered from the database itself
   * rather than from a hand-kept list — so a new table is backed up the day
   * it is created. Internal bookkeeping tables are left out.
   */
  tableNames: () => lock(async () => {
    if (driver === 'postgres') {
      const result = await exec(
        `SELECT tablename AS name FROM pg_tables
         WHERE schemaname = 'public' ORDER BY tablename`);
      return result.rows.map((row) => row.name);
    }
    const result = await exec(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`);
    return result.rows.map((row) => row.name);
  }),

  /** Row count per table, used to prove a restore is complete. */
  rowCounts: () => lock(async () => {
    const names = driver === 'postgres'
      ? (await exec(`SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`)).rows
      : (await exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)).rows;
    const counts = {};
    for (const { name } of names) {
      const row = await exec(`SELECT COUNT(*) AS c FROM "${name}"`);
      counts[name] = Number(row.rows[0].c);
    }
    return counts;
  }),

  /**
   * SQLite only: writes a complete, consistent copy of the live database to
   * `path`, using the engine's own VACUUM INTO. Readers and writers are not
   * blocked out for long, and the result is a single tidy file with no
   * separate write-ahead log to carry alongside it.
   */
  sqliteSnapshot: (path) => lock(async () => {
    if (driver !== 'sqlite') return false;
    // The path is built by the application, never by a request.
    sqlite.exec(`VACUUM INTO '${String(path).replace(/'/g, "''")}'`);
    return true;
  }),

  /**
   * SQLite only: every CREATE statement of the current database, in creation
   * order. Carried inside a backup so a row dump can rebuild its own schema
   * without needing the application's source.
   */
  sqliteSchemaSql: () => lock(async () => {
    if (driver !== 'sqlite') return '';
    const rows = sqlite.prepare(
      `SELECT sql FROM sqlite_master
       WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid`).all();
    return rows.map((row) => `${row.sql};`).join('\n');
  }),

  /** SQLite only: the engine's own corruption check. */
  sqliteIntegrityCheck: () => lock(async () => {
    if (driver !== 'sqlite') return 'ok';
    const row = sqlite.prepare('PRAGMA integrity_check').get();
    return String(Object.values(row)[0] || 'unknown');
  }),

  /** Where the SQLite file lives, for the backup to copy. */
  get sqlitePath() {
    return driver === 'sqlite' ? (process.env.DB_PATH || join(ROOT, 'data', 'app.db')) : null;
  },

  async close() {
    if (driver === 'postgres' && pg) await pg.end();
    if (driver === 'sqlite' && sqlite) sqlite.close();
    driver = null; pg = null; sqlite = null;
  },
};

export async function connectStore() {
  const url = process.env.DATABASE_URL;
  if (url && /^postgres/.test(url)) {
    driver = 'postgres';
    pg = new PgClient(url);
    await pg.connect();
    return { driver, target: url.replace(/:[^:@/]*@/, ':****@') };
  }
  const { DatabaseSync } = await import('node:sqlite');
  driver = 'sqlite';
  const path = process.env.DB_PATH || join(ROOT, 'data', 'app.db');
  mkdirSync(dirname(path), { recursive: true });
  sqlite = new DatabaseSync(path);
  sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec('PRAGMA busy_timeout = 5000');
  return { driver, target: path };
}

/** Primary-key clause differs between the two engines; everything else is shared. */
export const pk = () => (driver === 'postgres'
  ? 'BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY'
  : 'INTEGER PRIMARY KEY AUTOINCREMENT');

export const nowIso = () => new Date().toISOString();
