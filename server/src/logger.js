/*
 * Structured logging.
 *
 * One JSON object per line on stdout, so the output can be read by a person
 * during a pilot and piped into any log tool later without changing the code.
 *
 * PRIVACY: this module never writes a password, a password hash, a token, a
 * one-time code or a full address. Values are redacted by key name before
 * anything is printed, and a phone number or email is reduced to a short
 * fingerprint so the same person can be followed across lines without the
 * log itself identifying them.
 */
import crypto from 'node:crypto';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[process.env.LOG_LEVEL] || LEVELS.info;

/** Keys whose value is never printed, whatever it contains. */
const SECRET_KEYS = new Set([
  'password', 'password_hash', 'passwordHash', 'current_password', 'new_password',
  'token', 'jwt', 'secret', 'jwt_secret', 'authorization', 'code', 'code_hash',
  'otp', 'reset_token', 'idempotency_key', 'cookie',
]);

/** Keys that identify a person: kept as a short, stable fingerprint only. */
const IDENTITY_KEYS = new Set(['phone', 'email', 'destination', 'identifier', 'delivery_address', 'address']);

const fingerprint = (value) =>
  crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 10);

function clean(value, key = '', depth = 0) {
  if (key && SECRET_KEYS.has(key)) return '[redacted]';
  if (key && IDENTITY_KEYS.has(key) && value) return `#${fingerprint(value)}`;
  if (value === null || value === undefined) return value;
  if (depth > 3) return '[deep]';
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => clean(item, '', depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = clean(v, k, depth + 1);
    return out;
  }
  if (typeof value === 'string' && value.length > 300) return `${value.slice(0, 300)}…`;
  return value;
}

function write(level, event, fields = {}) {
  const entry = {
    t: new Date().toISOString(),
    level,
    event,
    ...clean(fields),
  };

  // Kept for the admin panel even when the level is below the print threshold,
  // so an operator can still see what happened without reading stdout.
  recent.push(entry);
  if (recent.length > RECENT_MAX) recent.shift();

  if (LEVELS[level] < MIN) return;
  const line = JSON.stringify(entry);
  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

/** Bounded in-memory tail of the log, newest first, for the admin panel. */
const RECENT_MAX = 200;
const recent = [];

export const recentEvents = (limit = 50) => recent.slice(-limit).reverse();

/* ------------------------------------------------------------------ *
 * Sending errors somewhere you will actually look
 * ------------------------------------------------------------------ */

/*
 * An optional Sentry hook, spoken by hand.
 *
 * Sentry's own SDK is a large dependency for one HTTP POST, and this project
 * has none; its ingest API is a single documented request, so that is what
 * this does.
 *
 * Two rules it must not break. Nothing identifying leaves the machine: every
 * field goes through the same clean() the local log uses, so a phone number
 * is a fingerprint and a token is never there at all. And it can never make
 * things worse: a Sentry outage, a wrong DSN or a crash loop must not slow
 * the app down or take it off the air, so sends are fire-and-forget, capped
 * per minute, and every failure is swallowed.
 */
const SENTRY_MAX_PER_MINUTE = 20;
const sentry = { parsed: undefined, sent: 0, dropped: 0, failed: 0, windowStart: 0 };

/**
 * Turns a DSN into the endpoint and key Sentry's ingest API wants.
 * Returns null for an empty or unparseable DSN.
 */
export function parseSentryDsn(dsn) {
  const raw = String(dsn || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const projectId = url.pathname.replace(/^\/+/, '');
    if (!url.username || !projectId) return null;
    return {
      endpoint: `${url.protocol}//${url.host}/api/${projectId}/store/`,
      key: url.username,
      projectId,
    };
  } catch {
    return null;
  }
}

const sentryTarget = () => {
  if (sentry.parsed === undefined) sentry.parsed = parseSentryDsn(process.env.SENTRY_DSN);
  return sentry.parsed;
};

/** Forgets the cached DSN; used by the tests when they change the environment. */
export const resetSentry = () => {
  sentry.parsed = undefined;
  sentry.sent = 0; sentry.dropped = 0; sentry.failed = 0; sentry.windowStart = 0;
};

export const sentryStats = () => ({
  configured: Boolean(sentryTarget()),
  sent: sentry.sent,
  dropped: sentry.dropped,
  failed: sentry.failed,
});

/** True while this minute still has room, so a crash loop cannot flood. */
function withinRate() {
  const now = Date.now();
  if (now - sentry.windowStart > 60_000) {
    sentry.windowStart = now;
    sentry.sent = 0;
  }
  return sentry.sent < SENTRY_MAX_PER_MINUTE;
}

/** The event body, already scrubbed. Exported so a test can read it. */
export function sentryEvent(event, fields, { level = 'error', error = null } = {}) {
  const body = {
    event_id: crypto.randomUUID().replace(/-/g, ''),
    timestamp: new Date().toISOString(),
    platform: 'node',
    level,
    logger: 'marhba',
    server_name: process.env.SENTRY_SERVER_NAME || 'marhba',
    environment: process.env.NODE_ENV || 'development',
    release: process.env.APP_VERSION || undefined,
    message: String(event),
    tags: { event: String(event) },
    extra: clean(fields || {}),
  };
  if (error) {
    body.exception = {
      values: [{
        type: error.name || 'Error',
        value: String(error.message || error).slice(0, 500),
        stacktrace: { frames: stackFrames(error) },
      }],
    };
  }
  return body;
}

/*
 * The stack, as Sentry wants it: innermost last, and only our own files.
 *
 * Absolute paths are trimmed to the project-relative part, which keeps the
 * server's directory layout — and the account name in it — out of a third
 * party's database.
 */
function stackFrames(error) {
  const lines = String(error.stack || '').split('\n').slice(1, 25);
  const frames = [];
  for (const line of lines) {
    const match = /at\s+(?:(.+?)\s+\()?(?:file:\/\/)?([^()]+?):(\d+):(\d+)\)?$/.exec(line.trim());
    if (!match) continue;
    const [, fn, file, lineNo, colNo] = match;
    frames.push({
      function: fn || '?',
      filename: String(file).replace(/^.*?((?:server|web|test)\/.*)$/, '$1'),
      lineno: Number(lineNo),
      colno: Number(colNo),
      in_app: /\/(server|web|test)\//.test(file) || /^(server|web|test)\//.test(file),
    });
  }
  return frames.reverse();
}

/**
 * Sends one event, if a DSN is configured. Never throws, never awaited by the
 * request path.
 */
export function captureToSentry(event, fields = {}, { level = 'error', error = null,
  fetchImpl = globalThis.fetch } = {}) {
  const target = sentryTarget();
  if (!target) return Promise.resolve(false);
  if (!withinRate()) { sentry.dropped += 1; return Promise.resolve(false); }
  sentry.sent += 1;

  const body = sentryEvent(event, fields, { level, error });
  return Promise.resolve()
    .then(() => fetchImpl(target.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=marhba/1.0, sentry_key=${target.key}`,
      },
      body: JSON.stringify(body),
    }))
    .then((response) => {
      if (!response || !response.ok) { sentry.failed += 1; return false; }
      return true;
    })
    .catch(() => { sentry.failed += 1; return false; });
}

/*
 * A crash is written down before the process dies.
 *
 * Without this an uncaught exception leaves nothing but whatever the shell
 * captured, which during a pilot is often nobody's terminal. The process
 * still exits — the supervisor is what restarts it — but now there is a line
 * saying why, locally and in Sentry.
 */
export function installCrashHandlers({ exit = true } = {}) {
  const handle = (kind) => (error) => {
    const real = error instanceof Error ? error : new Error(String(error));
    write('error', `process.${kind}`, { message: real.message, stack: real.stack });
    captureToSentry(`process.${kind}`, {}, { error: real });
    if (exit) {
      // A little time for the two writes above, then go; staying alive after
      // an uncaught exception leaves the process in an unknown state.
      setTimeout(() => process.exit(1), 250).unref?.();
    }
  };
  process.on('uncaughtException', handle('uncaughtException'));
  process.on('unhandledRejection', handle('unhandledRejection'));
}

export const log = {
  debug: (event, fields) => write('debug', event, fields),
  info: (event, fields) => write('info', event, fields),
  warn: (event, fields) => write('warn', event, fields),
  error: (event, fields) => {
    write('error', event, fields);
    // Errors are the one level worth paying to be told about.
    captureToSentry(event, fields, { level: 'error' });
  },
  /** Exposed for tests. */
  _clean: clean,
};
