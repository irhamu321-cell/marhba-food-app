/*
 * What the app knows about its own state.
 *
 * Two readers:
 *   GET /api/health        public, cheap, safe to expose to an uptime checker.
 *   GET /api/admin/health   signed in, the full picture for the admin panel.
 *
 * The public one never reveals anything an attacker could use: no paths, no
 * versions, no counts. It answers "is this working" and nothing else.
 */
import { statfsSync } from 'node:fs';
import { store, ROOT } from './store.js';
import { backupStatus, offsiteStatus } from './backup.js';
import { inspectEnvironment, isProduction } from './env.js';
import { sentryStats } from './logger.js';
import { streamStats } from './stream.js';
import { notifyState, notifyConfig } from './notify.js';
import { uploadStats } from './uploads.js';

const startedAt = Date.now();

/** Free space on the disk holding the data folder. */
export function diskSpace() {
  try {
    const info = statfsSync(ROOT);
    const total = info.blocks * info.bsize;
    const free = info.bavail * info.bsize;
    return {
      free_mb: Math.round(free / 1048576),
      total_mb: Math.round(total / 1048576),
      free_percent: total ? Math.round((free / total) * 1000) / 10 : null,
    };
  } catch {
    return { free_mb: null, total_mb: null, free_percent: null };
  }
}

/** Below either line, the app is at risk of failing to write. */
const DISK_WARN_MB = 500;
const DISK_WARN_PERCENT = 10;

export function diskWarning() {
  const disk = diskSpace();
  if (disk.free_mb === null) return null;
  if (disk.free_mb < DISK_WARN_MB || (disk.free_percent !== null && disk.free_percent < DISK_WARN_PERCENT)) {
    return {
      key: 'disk',
      level: disk.free_mb < DISK_WARN_MB / 5 ? 'critical' : 'warning',
      message: `Espace disque faible: ${disk.free_mb} Mo libres (${disk.free_percent}%).`,
    };
  }
  return null;
}

/** Can the database still answer? */
async function databaseOk() {
  try {
    await store.get('SELECT 1 AS ok');
    return { ok: true, error: '' };
  } catch (error) {
    return { ok: false, error: String(error.message || error).slice(0, 200) };
  }
}

/**
 * The short answer, for an uptime checker. Returns 200 when healthy and 503
 * when the database is unreachable, so a monitor needs no body parsing.
 */
export async function publicHealth() {
  const database = await databaseOk();
  return {
    status: database.ok ? 'ok' : 'degraded',
    ok: database.ok,
    time: new Date().toISOString(),
    uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
  };
}

/** Everything an administrator should see, including what needs fixing. */
export async function adminHealth() {
  const database = await databaseOk();
  const backup = backupStatus();
  const disk = diskSpace();
  const warnings = [];

  if (!database.ok) {
    warnings.push({ key: 'database', level: 'critical', message: `Base de donnees injoignable: ${database.error}` });
  }
  if (backup.last_failure_at && (!backup.last_success_at || backup.last_failure_at > backup.last_success_at)) {
    warnings.push({ key: 'backup', level: 'critical', message: `La derniere sauvegarde a echoue: ${backup.last_error}` });
  } else if (backup.stale) {
    warnings.push({
      key: 'backup', level: 'warning',
      message: backup.last_success_at
        ? `Aucune sauvegarde depuis ${backup.age_hours} heures.`
        : 'Aucune sauvegarde n a encore ete prise.',
    });
  }
  const diskIssue = diskWarning();
  if (diskIssue) warnings.push(diskIssue);

  /*
   * An alert channel that keeps failing is worth knowing about: it is
   * supposed to be the thing that tells you when something is wrong, so it
   * failing quietly defeats the point.
   */
  if (notifyState.webhook_failed > 0 && notifyState.webhook_sent === 0) {
    warnings.push({
      key: 'ORDER_WEBHOOK_URL',
      level: 'warning',
      message: `Le webhook de commande n a jamais abouti (${notifyState.webhook_failed} echec(s)): ${notifyState.last_error}`,
    });
  }
  if (notifyState.sms_failed > 0 && notifyState.sms_sent === 0) {
    warnings.push({
      key: 'ORDER_ALERT_SMS',
      level: 'warning',
      message: `L alerte SMS n a jamais abouti (${notifyState.sms_failed} echec(s)): ${notifyState.last_error}`,
    });
  }

  // Configuration problems are already computed at startup; show them here too.
  for (const problem of inspectEnvironment()) {
    warnings.push({
      key: problem.key,
      level: problem.fatal ? 'critical' : 'warning',
      message: problem.message,
    });
  }

  return {
    status: warnings.some((w) => w.level === 'critical') ? 'critical'
      : warnings.length ? 'warning' : 'ok',
    time: new Date().toISOString(),
    uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
    production: isProduction(),
    database: { driver: store.driver, ok: database.ok },
    backup: {
      last_success_at: backup.last_success_at,
      last_failure_at: backup.last_failure_at,
      last_error: backup.last_error,
      age_hours: backup.age_hours,
      stale: backup.stale,
      tables: backup.last_tables,
      rows: backup.last_rows,
      files: backup.files.slice(0, 5),
      // Photos can stop leaving the machine while the database copies keep
      // succeeding, so this count is reported next to them, not inside them.
      media_pending: backup.media_pending,
    },
    disk,
    uploads: uploadStats(),
    offsite: offsiteStatus(),
    streams: streamStats(),
    alerts: {
      webhook_configured: Boolean(notifyConfig().webhookUrl),
      sms_configured: notifyConfig().smsEnabled,
      ...notifyState,
    },
    sentry: sentryStats(),
    warnings,
  };
}
