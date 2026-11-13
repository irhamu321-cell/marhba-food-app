/*
 * Backups.
 *
 * Two kinds, written side by side every time:
 *
 *   1. data/backups/backup-YYYY-MM-DD.db    a byte-complete SQLite snapshot,
 *      taken with VACUUM INTO so it is consistent even while the app is running.
 *      This is the one a restore uses.
 *
 *   2. data/backups/backup-YYYY-MM-DD.json  a readable row dump of EVERY user
 *      table, discovered from the database itself rather than a hand-written
 *      list, so a new table can never be forgotten. Useful for inspection and
 *      for restoring onto PostgreSQL.
 *
 * Both carry a manifest with the schema version, the table list and a row count
 * per table. restore.js refuses a backup whose manifest does not match.
 */
import { mkdirSync, writeFileSync, readdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { store, ROOT } from './store.js';
import { log } from './logger.js';
import {
  pushOffsite, pushUploads, uploadsLedgerPath, pendingUploads,
  offsiteEnabled, offsiteStatus,
} from './offsite.js';
import { nowIso } from './store.js';

export const BACKUP_FORMAT = 2;
const KEEP = 14;

export const backupDir = () => join(ROOT, 'data', 'backups');
export const uploadsDir = () => join(ROOT, 'web', 'uploads');

/** Last outcome, read by /api/health and by the admin panel. */
export const backupState = {
  last_success_at: null,
  last_failure_at: null,
  last_error: '',
  last_file: '',
  last_tables: 0,
  last_rows: 0,
  running: false,
};

/**
 * Every table the application owns, discovered at runtime.
 * SQLite's own bookkeeping tables (sqlite_*) are left out.
 */
export const listTables = () => store.tableNames();

/** Row count per table. */
export const countRows = () => store.rowCounts();

/** Quotes an identifier so a table name can never be injected. */
function quote(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Nom de table invalide: ${name}`);
  return `"${name}"`;
}

/**
 * Takes a backup. Returns { db, json, manifest }.
 * The .db snapshot is only written on SQLite; PostgreSQL gets the JSON dump.
 */
export async function runBackup(label = null) {
  if (backupState.running) throw new Error('Une sauvegarde est deja en cours.');
  backupState.running = true;
  const dir = backupDir();
  const stamp = label || new Date().toISOString().slice(0, 10);

  try {
    mkdirSync(dir, { recursive: true });
    const tables = await listTables();
    const counts = await countRows();
    const totalRows = Object.values(counts).reduce((sum, n) => sum + n, 0);

    const manifest = {
      format: BACKUP_FORMAT,
      created_at: new Date().toISOString(),
      database: store.driver,
      tables,
      row_counts: counts,
      total_rows: totalRows,
      // Carried so a row dump can rebuild its own schema, with no source needed.
      schema_sql: await store.sqliteSchemaSql(),
    };

    // --- 1. the readable dump, every table ---
    const dump = { manifest, tables: {} };
    for (const table of tables) {
      dump.tables[table] = await store.all(`SELECT * FROM ${quote(table)}`);
    }
    const jsonFile = join(dir, `backup-${stamp}.json`);
    writeFileSync(jsonFile, JSON.stringify(dump));

    // --- 2. the consistent binary snapshot (SQLite only) ---
    let dbFile = '';
    let manifestFile = '';
    if (store.driver === 'sqlite') {
      dbFile = join(dir, `backup-${stamp}.db`);
      // VACUUM INTO refuses to overwrite, so clear a same-day file first.
      if (existsSync(dbFile)) rmSync(dbFile, { force: true });
      await store.sqliteSnapshot(dbFile);
      manifestFile = join(dir, `backup-${stamp}.manifest.json`);
      writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    }

    prune(dir);

    backupState.last_success_at = manifest.created_at;
    backupState.last_error = '';
    backupState.last_file = dbFile || jsonFile;
    backupState.last_tables = tables.length;
    backupState.last_rows = totalRows;
    log.info('backup.success', {
      tables: tables.length, rows: totalRows, file: baseName(dbFile || jsonFile),
    });

    /*
     * Off the machine, encrypted, if that is configured.
     *
     * Deliberately after the local backup is complete and after it has been
     * declared a success: a storage provider that is unreachable must not
     * turn a perfectly good local backup into a failure. Its own outcome is
     * recorded separately, in the audit log and in the admin panel.
     */
    if (offsiteEnabled()) {
      /*
       * The manifest goes too, and that is not optional: restore.js refuses a
       * .db snapshot whose manifest it cannot find, so a bucket holding only
       * the snapshot holds something that cannot be restored. The .json dump
       * carries its manifest inside itself and needs no sidecar.
       */
      await pushOffsite([dbFile, manifestFile, jsonFile].filter(Boolean), { audit: auditOffsite });

      /*
       * And the photos.
       *
       * The database holds each dish's image *path*; the image itself is a
       * file under web/uploads. Restoring a database-only backup brings back
       * every menu with every picture broken, and the restore reports no
       * problem at all, because nothing is missing as far as the database
       * knows. These go up once each, not every night: see pushUploads.
       */
      const media = await pushUploads(uploadsDir(), uploadsLedgerPath(ROOT), {
        audit: auditOffsite,
      });
      if (media.uploaded.length || media.failed.length) {
        log.info('offsite.media', {
          sent: media.uploaded.length, failed: media.failed.length, pending: media.pending,
        });
      }
    }

    return { db: dbFile, json: jsonFile, manifest };
  } catch (error) {
    backupState.last_failure_at = new Date().toISOString();
    backupState.last_error = String(error.message || error).slice(0, 300);
    log.error('backup.failure', { error: backupState.last_error });
    throw error;
  } finally {
    backupState.running = false;
  }
}

const baseName = (path) => String(path).split(/[\\/]/).pop();

/*
 * Writes the off-site outcome into audit_logs.
 *
 * Where money and data leave the system, there is a row saying so — a backup
 * that silently stopped leaving the machine for three months is exactly the
 * kind of thing an audit trail exists to make visible. actor_user_id is null
 * because nobody asked for this: the scheduler did.
 */
async function auditOffsite({ action, details }) {
  try {
    await store.run(
      `INSERT INTO audit_logs (actor_user_id, actor_role, action, resource_type, resource_id,
        details, ip, user_agent, created_at)
       VALUES (NULL, 'system', $1, 'backup', 0, $2, '', 'scheduler', $3)`,
      [action, JSON.stringify(details), nowIso()]);
  } catch (error) {
    // The audit row is a record of the upload, not the upload itself.
    log.warn('offsite.audit_failed', { error: String(error.message).slice(0, 160) });
  }
}

/** Keeps the newest KEEP days, deleting every file belonging to older ones. */
function prune(dir) {
  const days = [...new Set(readdirSync(dir)
    .map((name) => /^backup-(\d{4}-\d{2}-\d{2})/.exec(name))
    .filter(Boolean)
    .map((match) => match[1]))].sort().reverse();

  for (const day of days.slice(KEEP)) {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(`backup-${day}`)) rmSync(join(dir, name), { force: true });
    }
  }
}

/** What the admin panel and the health endpoint show. */
export function backupStatus() {
  const dir = backupDir();
  let files = [];
  try {
    files = readdirSync(dir)
      .filter((name) => name.endsWith('.db') || name.endsWith('.json'))
      .filter((name) => !name.endsWith('.manifest.json'))
      .map((name) => {
        const info = statSync(join(dir, name));
        return { name, bytes: info.size, modified: info.mtime.toISOString() };
      })
      .sort((a, b) => b.name.localeCompare(a.name))
      .slice(0, 20);
  } catch { files = []; }

  const last = backupState.last_success_at ? new Date(backupState.last_success_at).getTime() : 0;
  const ageHours = last ? (Date.now() - last) / 3600000 : null;

  /*
   * How many photos have never left the machine.
   *
   * Zero is the healthy number once off-site storage is on. A number that
   * only grows means uploads are failing every night while the database
   * copies keep succeeding, which otherwise looks like a working backup.
   */
  let mediaPending = 0;
  try { mediaPending = pendingUploads(uploadsDir(), uploadsLedgerPath(ROOT)).length; }
  catch { mediaPending = 0; }

  return {
    ...backupState,
    files,
    media_pending: mediaPending,
    age_hours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
    // A backup older than 36 hours means the daily run stopped working.
    stale: ageHours === null ? true : ageHours > 36,
  };
}

export function scheduleBackups() {
  const DAY = 24 * 60 * 60 * 1000;
  runBackup().catch(() => { /* already recorded in backupState and the log */ });
  const timer = setInterval(() => {
    runBackup().catch(() => { /* idem */ });
  }, DAY);
  timer.unref?.();
}

/** The off-site half of the backup picture, for the admin panel. */
export { offsiteStatus };
