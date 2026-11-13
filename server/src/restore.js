/*
 * Restore a backup into a NEW database file, and prove it is complete.
 *
 *   node src/restore.js ../data/backups/backup-2026-11-02.db  ../data/restored.db
 *   node src/restore.js ../data/backups/backup-2026-11-02.json ../data/restored.db
 *
 * It never writes over the live database. The target must not already exist
 * unless --force is passed, and the restore is verified before it is accepted:
 * every table named in the manifest must exist in the result and hold exactly
 * the number of rows the manifest recorded. A backup that is corrupted,
 * incomplete, or written by a different format version is refused.
 */
import { existsSync, copyFileSync, readFileSync, writeFileSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BACKUP_FORMAT } from './backup.js';
import { decryptBuffer } from './offsite.js';

export class RestoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const fail = (code, message) => { throw new RestoreError(code, message); };

/* ------------------------------------------------------------------ *
 * Reading a backup
 * ------------------------------------------------------------------ */

/** The manifest that belongs to a backup file, whichever kind it is. */
export function readManifest(backupPath) {
  const path = resolve(backupPath);
  if (!existsSync(path)) fail('missing', `Fichier de sauvegarde introuvable: ${path}`);
  if (statSync(path).size === 0) fail('empty', 'Le fichier de sauvegarde est vide.');

  if (path.endsWith('.json')) {
    let parsed;
    try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
    catch { fail('corrupt', 'Sauvegarde illisible: le JSON est corrompu.'); }
    if (!parsed || typeof parsed !== 'object') fail('corrupt', 'Sauvegarde illisible.');
    if (!parsed.manifest) fail('no_manifest', 'Sauvegarde sans manifeste: version trop ancienne.');
    return parsed.manifest;
  }

  // A .db snapshot keeps its manifest beside it.
  const sidecar = path.replace(/\.db$/, '.manifest.json');
  /*
   * Straight out of the bucket, the manifest is encrypted like everything
   * else. Decrypt it here rather than making whoever is restoring at two in
   * the morning work out that they needed a second command.
   */
  if (!existsSync(sidecar) && existsSync(`${sidecar}.enc`)) decryptArchive(`${sidecar}.enc`);
  if (!existsSync(sidecar)) fail('no_manifest', `Manifeste absent: ${sidecar}`);
  try { return JSON.parse(readFileSync(sidecar, 'utf8')); }
  catch { return fail('corrupt', 'Manifeste illisible.'); }
}

/** Refuses anything this version cannot safely restore. */
export function checkManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') fail('no_manifest', 'Manifeste absent.');
  if (Number(manifest.format) !== BACKUP_FORMAT) {
    fail('version', `Version de sauvegarde ${manifest.format ?? '?'}, attendue ${BACKUP_FORMAT}.`);
  }
  if (!Array.isArray(manifest.tables) || manifest.tables.length === 0) {
    fail('incomplete', 'Le manifeste ne liste aucune table.');
  }
  if (!manifest.row_counts || typeof manifest.row_counts !== 'object') {
    fail('incomplete', 'Le manifeste ne contient pas les totaux par table.');
  }
  for (const table of manifest.tables) {
    if (!(table in manifest.row_counts)) {
      fail('incomplete', `Total manquant pour la table ${table}.`);
    }
  }
  return manifest;
}

/* ------------------------------------------------------------------ *
 * Restoring
 * ------------------------------------------------------------------ */

const ident = (name) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) fail('corrupt', `Nom de table invalide: ${name}`);
  return `"${name}"`;
};

/** Copies a .db snapshot into place, after checking it opens and is sound. */
function restoreSnapshot(source, target) {
  copyFileSync(source, target);

  let db;
  try { db = new DatabaseSync(target); }
  catch {
    rmSync(target, { force: true });
    return fail('corrupt', 'La sauvegarde ne s ouvre pas: fichier corrompu.');
  }

  // A truncated or damaged file fails inside the engine, so every failure
  // from here on is reported as corruption rather than leaking a driver error.
  let verdict;
  try {
    const row = db.prepare('PRAGMA integrity_check').get();
    verdict = String(Object.values(row)[0] || '');
  } catch (error) {
    db.close();
    rmSync(target, { force: true });
    return fail('corrupt', `Sauvegarde illisible: ${error.message}`);
  }
  db.close();

  if (verdict !== 'ok') {
    rmSync(target, { force: true });
    fail('corrupt', `Base restauree corrompue: ${verdict}`);
  }
}

/**
 * Rebuilds a database from the readable JSON dump. The schema comes from the
 * manifest, so no source file is needed and an old dump restores as it was.
 */
function restoreJson(source, target, manifest) {
  const parsed = JSON.parse(readFileSync(source, 'utf8'));
  if (!parsed.tables || typeof parsed.tables !== 'object') {
    fail('incomplete', 'Sauvegarde sans donnees.');
  }
  if (!manifest.schema_sql) {
    fail('no_schema', 'Cette sauvegarde JSON ne contient pas son schema. Utilise la sauvegarde .db.');
  }
  // Every table the manifest promises must actually carry its rows.
  for (const table of manifest.tables) {
    if (!(table in parsed.tables)) {
      fail('incomplete', `Donnees absentes pour la table ${table}.`);
    }
  }

  const db = new DatabaseSync(target);
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(manifest.schema_sql);

    for (const table of manifest.tables) {
      const rows = parsed.tables[table];
      if (!Array.isArray(rows) || rows.length === 0) continue;
      const columns = Object.keys(rows[0]);
      const statement = db.prepare(
        `INSERT INTO ${ident(table)} (${columns.map(ident).join(',')})
         VALUES (${columns.map(() => '?').join(',')})`);
      for (const row of rows) {
        statement.run(...columns.map((column) => {
          const value = row[column];
          return value === undefined ? null : value;
        }));
      }
    }
  } catch (error) {
    db.close();
    rmSync(target, { force: true });
    if (error instanceof RestoreError) throw error;
    fail('corrupt', `Restauration impossible: ${error.message}`);
  }
  db.close();
}

/**
 * Restores `backupPath` into `targetPath` and verifies the result.
 * Returns a report: { tables, rows, checked, manifest }.
 */
/*
 * An off-site archive is encrypted; decrypt it to a neighbouring file first.
 *
 * This is the step people forget until the day they need it, so the restore
 * tool does it rather than leaving it as a manual openssl incantation written
 * down somewhere nobody can find. The path of the decrypted copy is returned
 * so the caller can delete it afterwards: it holds every customer's address.
 */
export function decryptArchive(archivePath, { passphrase = process.env.BACKUP_ENCRYPTION_KEY } = {}) {
  const source = resolve(archivePath);
  if (!existsSync(source)) fail('missing', `Archive introuvable: ${source}`);
  if (!passphrase) {
    fail('no_key', 'BACKUP_ENCRYPTION_KEY n est pas definie. Sans elle, cette archive '
      + 'ne peut pas etre lue: c est la cle qui n a jamais quitte le serveur.');
  }
  let plain;
  try {
    plain = decryptBuffer(readFileSync(source), passphrase);
  } catch (error) {
    fail('decrypt', `Dechiffrement impossible: ${error.message}. `
      + 'Verifie BACKUP_ENCRYPTION_KEY, ou le fichier a ete modifie.');
  }
  const target = source.replace(/\.enc$/, '');
  writeFileSync(target, plain);
  return target;
}

export function restoreBackup(backupPath, targetPath, { force = false } = {}) {
  let source = resolve(backupPath);
  const target = resolve(targetPath);

  // A file straight out of the bucket still has its encryption on.
  if (source.endsWith('.enc')) source = decryptArchive(source);

  const manifest = checkManifest(readManifest(source));

  if (existsSync(target)) {
    if (!force) fail('exists', `La cible existe deja: ${target}. Ajoute --force pour l ecraser.`);
    rmSync(target, { force: true });
  }
  rmSync(`${target}-wal`, { force: true });
  rmSync(`${target}-shm`, { force: true });
  mkdirSync(dirname(target), { recursive: true });

  if (source.endsWith('.json')) {
    restoreJson(source, target, manifest);
  } else {
    restoreSnapshot(source, target);
  }

  const report = verifyRestore(target, manifest);
  return { ...report, manifest };
}

/**
 * Opens the restored file and checks it against the manifest, table by table.
 * Throws on the first mismatch; returns the per-table detail on success.
 */
export function verifyRestore(targetPath, manifest) {
  const db = new DatabaseSync(resolve(targetPath));
  const checked = {};
  try {
    const present = new Set(db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).all().map((row) => row.name));

    for (const table of manifest.tables) {
      if (!present.has(table)) fail('missing_table', `Table absente apres restauration: ${table}`);
      const row = db.prepare(`SELECT COUNT(*) AS c FROM ${ident(table)}`).get();
      const got = Number(row.c);
      const want = Number(manifest.row_counts[table]);
      if (got !== want) {
        fail('row_mismatch', `Table ${table}: ${got} ligne(s) restaurees, ${want} attendues.`);
      }
      checked[table] = got;
    }

    const extra = [...present].filter((name) => !manifest.tables.includes(name));
    return {
      tables: manifest.tables.length,
      rows: Object.values(checked).reduce((sum, n) => sum + n, 0),
      checked,
      extra_tables: extra,
    };
  } finally {
    db.close();
  }
}

/* ------------------------------------------------------------------ *
 * Command line
 * ------------------------------------------------------------------ */
const isMain = process.argv[1] && process.argv[1].endsWith('restore.js');
if (isMain) {
  const args = process.argv.slice(2).filter((a) => a !== '--force');
  const force = process.argv.includes('--force');
  const [backup, target] = args;

  if (!backup || !target) {
    console.log('Usage: node src/restore.js <sauvegarde.db|.json|.enc> <cible.db> [--force]');
    console.log('       Pour une archive .enc, definis BACKUP_ENCRYPTION_KEY d abord.');
    process.exit(1);
  }
  try {
    const report = restoreBackup(backup, target, { force });
    console.log(`\n  Restauration verifiee: ${report.tables} table(s), ${report.rows} ligne(s).`);
    for (const [table, count] of Object.entries(report.checked)) {
      console.log(`    ${table.padEnd(22)} ${count}`);
    }
    if (report.extra_tables.length) {
      console.log(`  Tables en plus (ignorees): ${report.extra_tables.join(', ')}`);
    }
    console.log(`\n  Fichier restaure: ${resolve(target)}\n`);
  } catch (error) {
    console.error(`\n  Restauration refusee [${error.code || 'erreur'}]: ${error.message}\n`);
    process.exit(1);
  }
}
