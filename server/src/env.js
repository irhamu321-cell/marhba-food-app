/*
 * Reads a .env file sitting next to the app, if there is one.
 * One KEY=value per line, # starts a comment. Real environment variables win.
 */
import { readFileSync, existsSync } from 'node:fs';
import { missingBusinessFields } from '../config/business.js';
import { smsProvider, missingSmsConfig, smsConfig } from './sms.js';
import { offsiteConfig, offsiteEnabled, missingOffsiteConfig } from './offsite.js';
import { join } from 'node:path';

export function loadEnv(root) {
  const file = join(root, '.env');
  if (!existsSync(file)) return false;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * Startup checks
 *
 * In production the app refuses to start on a configuration that would be
 * unsafe in public: no secret, a weak or example secret, demo data switched
 * on, a wildcard CORS origin, or no administrator password. Outside
 * production the same problems are printed as warnings so they are visible
 * long before deployment.
 * ------------------------------------------------------------------ */

export const isProduction = () => String(process.env.NODE_ENV || '').toLowerCase() === 'production';

/** Secrets that must never reach a public server, whatever they are set to. */
const FORBIDDEN_SECRETS = new Set([
  'paste-a-long-random-string-here',
  'change-me', 'changeme', 'secret', 'dev', 'development', 'test',
  'a-long-random-string',
]);

/** Passwords shipped in earlier versions or in the documentation. */
const FORBIDDEN_PASSWORDS = new Set([
  'admin1234', 'resto1234', 'client1234', 'password', 'motdepasse', '12345678',
]);

/**
 * Looks at the environment and returns every problem found.
 * `fatal` means the app must not start in production.
 */
export function inspectEnvironment() {
  const problems = [];
  const production = isProduction();

  const secret = process.env.JWT_SECRET || '';
  if (!secret) {
    problems.push({ fatal: true, key: 'JWT_SECRET',
      message: 'JWT_SECRET n est pas defini. Sans lui, la cle de signature est un fichier local, ce qui ne convient pas en production.' });
  } else if (secret.length < 32) {
    problems.push({ fatal: true, key: 'JWT_SECRET',
      message: `JWT_SECRET ne fait que ${secret.length} caracteres. Il en faut au moins 32.` });
  } else if (FORBIDDEN_SECRETS.has(secret.toLowerCase())) {
    problems.push({ fatal: true, key: 'JWT_SECRET',
      message: 'JWT_SECRET est une valeur d exemple. Genere une chaine aleatoire longue.' });
  } else if (/^(.)\1+$/.test(secret)) {
    problems.push({ fatal: true, key: 'JWT_SECRET',
      message: 'JWT_SECRET repete un seul caractere. Genere une vraie chaine aleatoire.' });
  }

  if (String(process.env.SEED_DEMO_DATA || '').toLowerCase() === 'true') {
    problems.push({ fatal: true, key: 'SEED_DEMO_DATA',
      message: 'SEED_DEMO_DATA=true cree des comptes de demonstration dont le mot de passe est public. A ne jamais activer en production.' });
  }

  const cors = process.env.CORS_ORIGIN || '';
  if (cors === '*') {
    problems.push({ fatal: true, key: 'CORS_ORIGIN',
      message: 'CORS_ORIGIN=* ouvre l API a n importe quel site. Indique une seule origine, par exemple https://marhba.ma.' });
  } else if (cors && !/^https?:\/\/[^\s*]+$/.test(cors)) {
    problems.push({ fatal: true, key: 'CORS_ORIGIN',
      message: `CORS_ORIGIN n est pas une origine valide: ${cors}` });
  } else if (production && cors && cors.startsWith('http://')) {
    problems.push({ fatal: false, key: 'CORS_ORIGIN',
      message: 'CORS_ORIGIN utilise http:// et non https://.' });
  }

  const adminPassword = process.env.ADMIN_PASSWORD || '';
  if (adminPassword && FORBIDDEN_PASSWORDS.has(adminPassword.toLowerCase())) {
    problems.push({ fatal: true, key: 'ADMIN_PASSWORD',
      message: 'ADMIN_PASSWORD est un mot de passe de demonstration connu. Choisis-en un autre.' });
  } else if (adminPassword && adminPassword.length < 12) {
    problems.push({ fatal: production, key: 'ADMIN_PASSWORD',
      message: `ADMIN_PASSWORD ne fait que ${adminPassword.length} caracteres. Il en faut au moins 12.` });
  } else if (production && !adminPassword) {
    problems.push({ fatal: true, key: 'ADMIN_PASSWORD',
      message: 'ADMIN_PASSWORD doit etre defini en production: aucun mot de passe administrateur ne doit etre genere ou devine.' });
  }

  const missingLegal = missingBusinessFields();
  if (missingLegal.length) {
    problems.push({
      fatal: production,
      key: 'BUSINESS',
      message: `Mentions legales incompletes. A remplir dans server/config/business.js ou dans .env: ${missingLegal.join(', ')}.`,
    });
  }

  /*
   * SMS.
   *
   * A public server that cannot send a code cannot register a customer, and
   * the console driver would print codes into a log file instead of sending
   * them, so production refuses both an unset provider and the console one.
   */
  const provider = smsProvider();
  if (production && (!provider || provider === 'console')) {
    problems.push({
      fatal: true,
      key: 'SMS_PROVIDER',
      message: provider === 'console'
        ? 'SMS_PROVIDER=console en production: les codes seraient ecrits dans le journal au lieu d etre envoyes. Choisis infobip, twilio ou generic_http.'
        : 'SMS_PROVIDER n est pas defini. Choisis infobip, twilio ou generic_http (voir .env.example).',
    });
  } else {
    const missingSms = missingSmsConfig(smsConfig());
    if (missingSms.length) {
      problems.push({
        fatal: production,
        key: 'SMS_PROVIDER',
        message: `Configuration SMS incomplete pour "${provider}": ${missingSms.join(', ')}.`,
      });
    }
  }

  /*
   * Off-site backups.
   *
   * Half-configured is the dangerous state: someone sets three of the five
   * variables, sees no error, and believes their backups are leaving the
   * machine. So a partial configuration is reported, and in production it
   * stops the server rather than pretending.
   */
  const offsite = offsiteConfig();
  const anyOffsite = offsite.endpoint || offsite.bucket || offsite.key
    || offsite.secret || offsite.passphrase;
  if (anyOffsite) {
    const missingOffsite = missingOffsiteConfig(offsite);
    if (missingOffsite.length) {
      problems.push({
        fatal: production,
        key: 'BACKUP_S3',
        message: `Sauvegarde hors site incomplete: ${missingOffsite.join(', ')}. `
          + 'Renseigne tout ou rien: a moitie configuree, aucune copie ne quitte la machine.',
      });
    }
  } else if (production) {
    problems.push({
      fatal: false,
      key: 'BACKUP_S3',
      message: 'Aucune sauvegarde hors site configuree. Une sauvegarde sur le meme disque '
        + 'que la base n en est pas une: voir BACKUP_S3_ENDPOINT dans .env.example.',
    });
  }

  if (production && !process.env.TRUST_PROXY) {
    problems.push({ fatal: false, key: 'TRUST_PROXY',
      message: 'TRUST_PROXY n est pas defini. Derriere Caddy ou nginx, mets TRUST_PROXY=1 pour que les adresses IP des logs soient justes.' });
  }

  return problems;
}

/**
 * Prints the findings. In production a fatal problem stops the process here,
 * before a single request can be served.
 */
export function enforceEnvironment({ exit = true } = {}) {
  const problems = inspectEnvironment();
  const production = isProduction();
  const fatal = problems.filter((p) => p.fatal);
  const warnings = problems.filter((p) => !p.fatal);

  if (production && fatal.length) {
    console.error('');
    console.error('  ==========================================================');
    console.error('   DEMARRAGE REFUSE — configuration de production incorrecte');
    console.error('  ==========================================================');
    for (const problem of fatal) console.error(`   [${problem.key}] ${problem.message}`);
    console.error('');
    console.error('   Corrige le fichier .env, puis relance.');
    console.error('');
    if (exit) process.exit(1);
    return { ok: false, fatal, warnings };
  }

  if (!production && (fatal.length || warnings.length)) {
    console.log('');
    console.log('  Mode developpement. A corriger avant la mise en ligne :');
    for (const problem of [...fatal, ...warnings]) {
      console.log(`    - [${problem.key}] ${problem.message}`);
    }
    console.log('');
  } else if (production && warnings.length) {
    for (const problem of warnings) console.warn(`  Avertissement [${problem.key}] ${problem.message}`);
  }

  return { ok: true, fatal, warnings };
}
