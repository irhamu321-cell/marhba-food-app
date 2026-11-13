/*
 * Sending a backup off the machine, encrypted, to S3-compatible storage.
 *
 * A backup on the same disk as the database is not a backup: the disk that
 * loses the database loses it too. This pushes each day's snapshot to
 * Cloudflare R2, Backblaze B2, AWS S3 or anything else that speaks the same
 * API, with two properties that matter more than convenience.
 *
 * It is encrypted before it leaves. The archive contains every customer's
 * name, phone number and address, and the storage provider — and anyone who
 * ever gets hold of a bucket credential — has no business reading them. The
 * key never leaves this machine, which also means a lost key means a lost
 * backup: that trade is stated plainly in the README.
 *
 * It is signed by hand. S3 authentication is AWS Signature V4, which is a
 * documented sequence of SHA-256 hashes; the official SDK is tens of
 * megabytes of dependency for one PUT, and this project has none.
 */
import crypto from 'node:crypto';
import {
  createReadStream, statSync, existsSync, readdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { log } from './logger.js';

export const offsiteConfig = () => ({
  endpoint: String(process.env.BACKUP_S3_ENDPOINT || '').trim().replace(/\/+$/, ''),
  bucket: String(process.env.BACKUP_S3_BUCKET || '').trim(),
  key: String(process.env.BACKUP_S3_KEY || '').trim(),
  secret: String(process.env.BACKUP_S3_SECRET || '').trim(),
  region: String(process.env.BACKUP_S3_REGION || 'auto').trim(),
  prefix: String(process.env.BACKUP_S3_PREFIX || 'marhba').trim().replace(/^\/+|\/+$/g, ''),
  passphrase: String(process.env.BACKUP_ENCRYPTION_KEY || '').trim(),
});

export const offsiteEnabled = (config = offsiteConfig()) =>
  Boolean(config.endpoint && config.bucket && config.key && config.secret);

/** What is missing, for the startup check and the admin panel. */
export function missingOffsiteConfig(config = offsiteConfig()) {
  const missing = [];
  if (!config.endpoint) missing.push('BACKUP_S3_ENDPOINT');
  if (!config.bucket) missing.push('BACKUP_S3_BUCKET');
  if (!config.key) missing.push('BACKUP_S3_KEY');
  if (!config.secret) missing.push('BACKUP_S3_SECRET');
  if (!config.passphrase) missing.push('BACKUP_ENCRYPTION_KEY');
  return missing;
}

export const offsiteState = {
  last_success_at: null,
  last_failure_at: null,
  last_error: '',
  last_key: '',
  last_bytes: 0,
  uploads: 0,
  failures: 0,
};

/* ------------------------------------------------------------------ *
 * Encryption
 * ------------------------------------------------------------------ */

const MAGIC = Buffer.from('MRHB1', 'latin1');
const SALT_BYTES = 16;
const IV_BYTES = 12;

/**
 * AES-256-GCM, with the key derived from the passphrase by scrypt.
 *
 * The file begins with its own salt and nonce, so decrypting needs nothing
 * but the passphrase — no key file to lose separately, and no database to
 * read it from, which matters when the thing you are restoring IS the
 * database.
 *
 * GCM means a tampered archive fails to decrypt rather than restoring
 * something subtly wrong.
 */
export function encryptBuffer(plain, passphrase) {
  if (!passphrase) throw new Error('BACKUP_ENCRYPTION_KEY manquante');
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const key = crypto.scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, salt, iv, tag, body]);
}

export function decryptBuffer(archive, passphrase) {
  if (!passphrase) throw new Error('BACKUP_ENCRYPTION_KEY manquante');
  if (archive.length < MAGIC.length + SALT_BYTES + IV_BYTES + 16) {
    throw new Error('archive trop courte');
  }
  if (!archive.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('ce fichier n est pas une archive Marhba');
  }
  let at = MAGIC.length;
  const salt = archive.subarray(at, at += SALT_BYTES);
  const iv = archive.subarray(at, at += IV_BYTES);
  const tag = archive.subarray(at, at += 16);
  const body = archive.subarray(at);
  const key = crypto.scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/* ------------------------------------------------------------------ *
 * AWS Signature V4
 * ------------------------------------------------------------------ */

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => crypto.createHmac('sha256', key).update(value).digest();

/**
 * Builds the headers for one signed PUT.
 *
 * Exported whole so the tests can check the canonical request and the
 * signature without a bucket: a wrong signature is the single most likely
 * failure here, and it is invisible until the first real upload.
 */
export function signPut({ config, objectKey, body, now = new Date(), contentType = 'application/octet-stream' }) {
  const url = new URL(`${config.endpoint}/${config.bucket}/${objectKey}`);
  const amzDate = `${now.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(body);

  const headers = {
    host: url.host,
    'content-type': contentType,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };

  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort()
    .map((name) => `${name}:${String(headers[name]).trim()}\n`).join('');

  /*
   * Each path segment is encoded, but the slashes between them are not —
   * S3 treats the key as a path, and encoding its separators would create an
   * object whose name contains "%2F".
   */
  const canonicalUri = url.pathname.split('/')
    .map((segment) => encodeURIComponent(decodeURIComponent(segment)))
    .join('/');

  const canonicalRequest = [
    'PUT', canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest),
  ].join('\n');

  const signingKey = hmac(hmac(hmac(hmac(
    `AWS4${config.secret}`, dateStamp), config.region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  return {
    url: url.toString(),
    headers: {
      ...headers,
      Authorization: `AWS4-HMAC-SHA256 Credential=${config.key}/${scope}, `
        + `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    canonicalRequest,
    stringToSign,
  };
}

/* ------------------------------------------------------------------ *
 * The upload
 * ------------------------------------------------------------------ */

/** Where one day's file lands in the bucket. */
export const objectKeyFor = (filename, {
  prefix = 'marhba', now = new Date(), folder = '',
} = {}) => {
  /*
   * Database archives are filed by month, because there is one set per day
   * and the month is how anyone looks for them. Media is filed under a plain
   * `uploads/` folder with no date at all: a photo is sent once, and burying
   * it under the month it happened to be uploaded in would mean hunting
   * through twelve folders to restore one menu.
   */
  if (folder) return [prefix, folder, `${filename}.enc`].filter(Boolean).join('/');
  const day = now.toISOString().slice(0, 10);
  const parts = [prefix, day.slice(0, 7), `${filename}.enc`].filter(Boolean);
  return parts.join('/');
};

/**
 * Encrypts one local file and PUTs it. Returns { key, bytes }.
 *
 * Throws on failure; the caller decides whether that matters. It never
 * deletes or changes the local copy, so a failed upload leaves the backup
 * exactly where it was.
 */
export async function uploadBackupFile(filePath, {
  config = offsiteConfig(), fetchImpl = globalThis.fetch, now = new Date(), keyFolder = '',
} = {}) {
  if (!offsiteEnabled(config)) throw new Error('stockage hors site non configure');
  if (!existsSync(filePath)) throw new Error(`fichier introuvable: ${filePath}`);

  const missing = missingOffsiteConfig(config);
  if (missing.length) throw new Error(`configuration incomplete: ${missing.join(', ')}`);

  const { readFileSync } = await import('node:fs');
  const plain = readFileSync(filePath);
  const archive = encryptBuffer(plain, config.passphrase);
  const objectKey = objectKeyFor(basename(filePath), {
    prefix: config.prefix, now, folder: keyFolder,
  });

  const signed = signPut({ config, objectKey, body: archive, now });
  const response = await fetchImpl(signed.url, {
    method: 'PUT',
    headers: signed.headers,
    body: archive,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`${response.status} ${String(text).slice(0, 200)}`);
  }
  return {
    key: objectKey, file: basename(filePath),
    bytes: archive.length, plain_bytes: plain.length,
  };
}

/**
 * Pushes a day's backup files off the machine, and records what happened.
 *
 * Never throws: a storage provider being unreachable must not stop the local
 * backup from having been taken. The failure is logged, counted, and shown in
 * the admin panel, which is where someone will notice it.
 */
/* ------------------------------------------------------------------ *
 * Uploaded media
 * ------------------------------------------------------------------ */

/*
 * The photos have to leave the machine too.
 *
 * The daily backup copies the database, and the database is where a dish's
 * image *path* lives — not the image. A disk failure with only the database
 * backed up restores every menu with every picture broken, and nothing in the
 * restore reports a problem, because as far as the database is concerned
 * nothing is missing. So the files go off-site as well.
 *
 * They go incrementally. A restaurant's logo does not change from one day to
 * the next, and re-encrypting and re-sending every photo every night would
 * cost real money on a metered bucket for no gain. A small ledger beside the
 * database remembers what has already been sent; anything not in it goes up,
 * and anything already up is left alone.
 *
 * The ledger is a convenience, not the source of truth: delete it and the
 * next run simply sends everything again, which is wasteful but correct.
 */
const UPLOAD_PATTERN = /\.(?:jpg|jpeg|png|webp)$/i;

export const uploadsLedgerPath = (root) => join(root, 'data', 'offsite-uploads.json');

export function readUploadLedger(ledgerPath) {
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    return Array.isArray(parsed.sent) ? new Set(parsed.sent) : new Set();
  } catch {
    return new Set();
  }
}

export function writeUploadLedger(ledgerPath, sent) {
  try {
    writeFileSync(ledgerPath, JSON.stringify({
      updated_at: new Date().toISOString(),
      sent: [...sent].sort(),
    }, null, 1));
    return true;
  } catch (error) {
    log.warn('offsite.ledger_failed', { error: String(error.message).slice(0, 160) });
    return false;
  }
}

/** Media files present on disk but not yet sent off-site. */
export function pendingUploads(uploadsDir, ledgerPath) {
  if (!existsSync(uploadsDir)) return [];
  const sent = readUploadLedger(ledgerPath);
  return readdirSync(uploadsDir)
    .filter((name) => UPLOAD_PATTERN.test(name))
    .filter((name) => !sent.has(name))
    .sort()
    .map((name) => join(uploadsDir, name));
}

/**
 * Sends media that has not gone off-site yet, and records what went.
 *
 * Only names that actually uploaded are written to the ledger, so a file that
 * failed tonight is retried tomorrow instead of being quietly forgotten.
 */
export async function pushUploads(uploadsDir, ledgerPath, options = {}) {
  const pending = pendingUploads(uploadsDir, ledgerPath);
  if (!pending.length) return { skipped: false, uploaded: [], failed: [], pending: 0 };

  const result = await pushOffsite(pending, { ...options, keyFolder: 'uploads' });
  if (result.skipped) return { ...result, pending: pending.length };

  if (result.uploaded.length) {
    const sent = readUploadLedger(ledgerPath);
    for (const item of result.uploaded) sent.add(item.file);
    writeUploadLedger(ledgerPath, sent);
  }
  return { ...result, pending: pending.length };
}

export async function pushOffsite(filePaths, {
  config = offsiteConfig(), fetchImpl = globalThis.fetch, now = new Date(), audit = null,
  keyFolder = '',
} = {}) {
  if (!offsiteEnabled(config)) return { skipped: true, uploaded: [], failed: [] };

  const uploaded = [];
  const failed = [];

  for (const filePath of filePaths) {
    try {
      const result = await uploadBackupFile(filePath, { config, fetchImpl, now, keyFolder });
      uploaded.push(result);
      offsiteState.uploads += 1;
      offsiteState.last_key = result.key;
      offsiteState.last_bytes = result.bytes;
      log.info('offsite.uploaded', {
        key: result.key, bytes: result.bytes, plain_bytes: result.plain_bytes,
      });
    } catch (error) {
      failed.push({ file: basename(filePath), error: error.message });
      offsiteState.failures += 1;
      offsiteState.last_error = error.message;
      log.error('offsite.failed', {
        file: basename(filePath), error: String(error.message).slice(0, 200),
      });
    }
  }

  const at = new Date().toISOString();
  if (failed.length) offsiteState.last_failure_at = at;
  if (uploaded.length && !failed.length) offsiteState.last_success_at = at;

  // Written into audit_logs by the caller, which owns the database handle.
  if (audit) {
    await audit({
      action: failed.length ? 'backup_offsite_failed' : 'backup_offsite',
      details: {
        uploaded: uploaded.map((u) => u.key),
        failed,
        bytes: uploaded.reduce((total, u) => total + u.bytes, 0),
      },
    });
  }

  return { skipped: false, uploaded, failed };
}

export const offsiteStatus = () => ({
  enabled: offsiteEnabled(),
  missing: offsiteEnabled() ? missingOffsiteConfig() : [],
  ...offsiteState,
});
