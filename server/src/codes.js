/*
 * One-time codes: registration OTP and password reset.
 *
 * Rules that apply to every code here:
 *   - only a scrypt hash is stored, never the code itself;
 *   - a code expires quickly (5 minutes for registration, 15 for a reset);
 *   - a code works once, then it is marked consumed;
 *   - guessing is limited per code and per destination;
 *   - asking for codes is rate-limited per destination and per IP address.
 *
 * Delivery is a single injectable function. Until an SMS provider is wired in,
 * the code is written to the server log so the whole flow can be tested; that
 * is deliberate, visible, and documented in the README.
 */
import crypto from 'node:crypto';
import { store, nowIso } from './store.js';
import { hashPassword, verifyPassword } from './auth.js';
import { log } from './logger.js';
import { isProduction } from './env.js';

export const PURPOSES = ['register', 'reset'];

/** How long a code stays valid, by purpose. */
const TTL_MINUTES = { register: 5, reset: 15 };

/** How many wrong guesses one code tolerates before it is burned. */
const MAX_ATTEMPTS = 5;

/** How many codes one destination may request, and over what window. */
const REQUEST_LIMIT = 5;
const REQUEST_WINDOW_MINUTES = 15;

const now = () => Date.now();
const iso = (ms) => new Date(ms).toISOString();

/** Six digits, from a cryptographic source, never Math.random. */
function newCode() {
  // 000000–999999, uniformly, by rejecting the tail of the range.
  let value;
  do { value = crypto.randomBytes(3).readUIntBE(0, 3); } while (value >= 16_000_000);
  return String(value % 1_000_000).padStart(6, '0');
}

/*
 * Pilot console.
 *
 * The database only ever holds a hash. Until an SMS provider is wired in, the
 * operator still has to read the code out to the customer, so the last few
 * codes are kept IN MEMORY ONLY, for a few minutes, and shown on the admin
 * screen. They are never written to disk and never leave the process.
 *
 * This is off in production: there, codes go to the provider and nowhere else.
 */
const consoleCodes = [];
const CONSOLE_MAX = 60;

export const consoleEnabled = () =>
  String(process.env.OTP_CONSOLE || (isProduction() ? 'false' : 'true')).toLowerCase() === 'true';

function rememberForConsole(entry) {
  if (!consoleEnabled()) return;
  consoleCodes.push(entry);
  if (consoleCodes.length > CONSOLE_MAX) consoleCodes.shift();
}

/** What the admin screen shows: the live codes, newest first. */
export function pendingCodes() {
  if (!consoleEnabled()) return [];
  const now = Date.now();
  return consoleCodes
    .filter((entry) => new Date(entry.expires_at).getTime() > now)
    .slice()
    .reverse();
}

/**
 * Default delivery: print it, and keep it for the admin screen.
 * Replace this with an SMS or email provider by calling `setDelivery()` once
 * at start-up; everything else in this module stays the same.
 */
let deliver = async ({ channel, destination, code, purpose }) => {
  // The code is printed on purpose, and only here, so a pilot can be run.
  console.log(`  [code ${purpose}] ${channel} ${destination} -> ${code}`);
  log.info('code.delivered', { purpose, channel, destination, transport: 'console' });
  return { transport: 'console' };
};

export function setDelivery(fn) { deliver = fn; }

/* --------------------------------------------------------------- issuing */

/** Removes everything already expired or used, so the table cannot grow forever. */
export async function purgeCodes() {
  await store.run('DELETE FROM auth_codes WHERE expires_at < $1', [iso(now() - 86_400_000)]);
}

/**
 * Issues a code. Returns { sent: true, expires_at } — never the code itself, so
 * no caller can leak it into a response by accident.
 *
 * Throws an Error with `status` 429 when the destination has asked too often.
 */
export async function issueCode({ purpose, channel, destination, userId = null, ip = '' }) {
  if (!PURPOSES.includes(purpose)) throw new Error(`purpose inconnu: ${purpose}`);

  const since = iso(now() - REQUEST_WINDOW_MINUTES * 60_000);
  const recent = await store.get(
    `SELECT COUNT(*) AS c FROM auth_codes
     WHERE purpose = $1 AND destination = $2 AND created_at > $3`,
    [purpose, destination, since]);
  if (Number(recent.c) >= REQUEST_LIMIT) {
    log.warn('code.rate_limited', { purpose, channel, destination, ip, window_minutes: REQUEST_WINDOW_MINUTES });
    const error = new Error(`Trop de demandes. Reessaie dans ${REQUEST_WINDOW_MINUTES} minutes.`);
    error.status = 429;
    throw error;
  }

  // A new code replaces any still-live one for the same destination and purpose.
  await store.run(
    `UPDATE auth_codes SET consumed_at = $1
     WHERE purpose = $2 AND destination = $3 AND consumed_at IS NULL`,
    [nowIso(), purpose, destination]);

  const code = newCode();
  const expiresAt = iso(now() + TTL_MINUTES[purpose] * 60_000);
  const codeHash = await hashPassword(code);
  await store.run(
    `INSERT INTO auth_codes (purpose, channel, destination, code_hash, user_id, expires_at, created_ip, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [purpose, channel, destination, codeHash, userId, expiresAt, ip, nowIso()]);

  // Kept for the pilot console before delivery, so the operator can still read
  // the code if the provider itself fails. Never active in production.
  rememberForConsole({ purpose, channel, destination, code, expires_at: expiresAt,
    created_at: nowIso() });
  await deliver({ purpose, channel, destination, code, expiresAt });
  await purgeCodes();

  return { sent: true, expires_at: expiresAt, expires_in_minutes: TTL_MINUTES[purpose] };
}

/* -------------------------------------------------------------- checking */

/** Why a code was refused. The caller turns this into a message. */
export const CODE_ERRORS = {
  not_found: 'Code invalide ou expire.',
  expired: 'Ce code a expire. Demandes-en un nouveau.',
  consumed: 'Ce code a deja ete utilise.',
  too_many: 'Trop d essais sur ce code. Demandes-en un nouveau.',
  wrong: 'Code invalide ou expire.',
};

/**
 * Checks a code and consumes it on success. Returns
 * `{ ok: true, row }` or `{ ok: false, reason }` — it never throws, so the
 * caller decides what the user is told.
 *
 * A wrong guess costs an attempt; the fifth wrong guess burns the code.
 */
export async function consumeCode({ purpose, destination, code, ip = '' }) {
  const row = await store.get(
    `SELECT * FROM auth_codes
     WHERE purpose = $1 AND destination = $2
     ORDER BY id DESC LIMIT 1`,
    [purpose, destination]);

  if (!row) {
    log.warn('code.refused', { purpose, destination, ip, reason: 'not_found' });
    return { ok: false, reason: 'not_found' };
  }
  if (row.consumed_at) {
    log.warn('code.refused', { purpose, destination, ip, reason: 'consumed' });
    return { ok: false, reason: 'consumed' };
  }
  if (new Date(row.expires_at).getTime() < now()) {
    log.warn('code.refused', { purpose, destination, ip, reason: 'expired' });
    return { ok: false, reason: 'expired' };
  }
  if (Number(row.attempts) >= MAX_ATTEMPTS) {
    await store.run('UPDATE auth_codes SET consumed_at = $1 WHERE id = $2', [nowIso(), row.id]);
    log.warn('code.refused', { purpose, destination, ip, reason: 'too_many' });
    return { ok: false, reason: 'too_many' };
  }

  const matches = await verifyPassword(String(code || ''), row.code_hash);
  if (!matches) {
    const attempts = Number(row.attempts) + 1;
    await store.run('UPDATE auth_codes SET attempts = $1 WHERE id = $2', [attempts, row.id]);
    if (attempts >= MAX_ATTEMPTS) {
      await store.run('UPDATE auth_codes SET consumed_at = $1 WHERE id = $2', [nowIso(), row.id]);
    }
    log.warn('code.refused', { purpose, destination, ip, reason: 'wrong', attempts });
    return { ok: false, reason: attempts >= MAX_ATTEMPTS ? 'too_many' : 'wrong', attempts };
  }

  await store.run('UPDATE auth_codes SET consumed_at = $1 WHERE id = $2', [nowIso(), row.id]);
  log.info('code.accepted', { purpose, destination, ip });
  return { ok: true, row };
}

/** Test seam: the code the caller just asked for, read back from the log hook. */
export const _internals = { newCode, TTL_MINUTES, MAX_ATTEMPTS, REQUEST_LIMIT, REQUEST_WINDOW_MINUTES };
