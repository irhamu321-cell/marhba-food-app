/*
 * Startup guards: what production refuses, and what it accepts.
 *   node test/startup.mjs
 */
let pass = 0, fail = 0;
const failures = [];
const check = (label, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(label); console.log(`  FAIL ${label} ${extra}`); }
};
const section = (name) => console.log(`\n== ${name} ==`);

const { inspectEnvironment, enforceEnvironment, isProduction } = await import('../server/src/env.js');

const GOOD_SECRET = 'd3f8a1c0b7e429af61d05c8b3a7e92f4d6c1b8a0e5f37d29';
const GOOD_ADMIN = 'un-mot-de-passe-vraiment-long';

/** A complete business identity, so a valid configuration really is valid. */
const GOOD_BUSINESS = {
  BUSINESS_NAME: 'Marhba Test SARL',
  LEGAL_FORM: 'SARL',
  RC_NUMBER: 'RC-000000',
  ICE_NUMBER: '000000000000000',
  BUSINESS_ADDRESS: '1 rue de Test',
  BUSINESS_CITY: 'Kenitra',
  BUSINESS_PHONE: '0500000000',
  BUSINESS_EMAIL: 'contact@test.local',
  RESPONSIBLE_PERSON: 'Responsable Test',
};

/** A working SMS provider, so a valid configuration really is valid. */
const GOOD_SMS = {
  SMS_PROVIDER: 'generic_http',
  SMS_API_URL: 'https://sms.example.ma/send',
  SMS_API_KEY: 'une-cle-de-test',
  SMS_SENDER_ID: 'Marhba',
};

/*
 * A complete off-site backup configuration.
 *
 * Production warns when backups never leave the machine, which is correct and
 * which the checks below would otherwise trip over, so a fully configured
 * bucket is part of what "a clean production environment" means here.
 */
const GOOD_OFFSITE = {
  BACKUP_S3_ENDPOINT: 'https://s3.example.com',
  BACKUP_S3_BUCKET: 'marhba-sauvegardes',
  BACKUP_S3_KEY: 'cle-de-test',
  BACKUP_S3_SECRET: 'secret-de-test',
  BACKUP_ENCRYPTION_KEY: 'phrase-de-chiffrement-de-test',
};

/** Runs the checks with exactly this environment, then puts it back. */
function withEnv(vars, fn) {
  const keys = ['NODE_ENV', 'JWT_SECRET', 'SEED_DEMO_DATA', 'CORS_ORIGIN', 'ADMIN_PASSWORD', 'TRUST_PROXY',
    'BUSINESS_NAME', 'LEGAL_FORM', 'RC_NUMBER', 'ICE_NUMBER', 'BUSINESS_ADDRESS',
    'BUSINESS_CITY', 'BUSINESS_PHONE', 'BUSINESS_EMAIL', 'RESPONSIBLE_PERSON',
    'SMS_PROVIDER', 'SMS_API_KEY', 'SMS_API_URL', 'SMS_SENDER_ID',
    'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN',
    // Every variable this helper does not clear leaks from one case into the
    // next, and a leaked value silently turns a later check into a no-op.
    'BACKUP_S3_ENDPOINT', 'BACKUP_S3_BUCKET', 'BACKUP_S3_KEY', 'BACKUP_S3_SECRET',
    'BACKUP_S3_REGION', 'BACKUP_S3_PREFIX', 'BACKUP_ENCRYPTION_KEY'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, vars);
  try { return fn(); }
  finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const fatalKeys = (vars) => withEnv(vars, () => inspectEnvironment().filter((p) => p.fatal).map((p) => p.key));

section('Production: ce qui est refuse');

check('sans JWT_SECRET -> refus',
  fatalKeys({ NODE_ENV: 'production', ADMIN_PASSWORD: GOOD_ADMIN }).includes('JWT_SECRET'));

check('JWT_SECRET trop court -> refus',
  fatalKeys({ NODE_ENV: 'production', JWT_SECRET: 'court', ADMIN_PASSWORD: GOOD_ADMIN }).includes('JWT_SECRET'));

check('JWT_SECRET d exemple -> refus',
  fatalKeys({ NODE_ENV: 'production', JWT_SECRET: 'paste-a-long-random-string-here', ADMIN_PASSWORD: GOOD_ADMIN })
    .includes('JWT_SECRET'));

check('JWT_SECRET repetitif -> refus',
  fatalKeys({ NODE_ENV: 'production', JWT_SECRET: 'a'.repeat(40), ADMIN_PASSWORD: GOOD_ADMIN }).includes('JWT_SECRET'));

check('donnees de demo activees -> refus',
  fatalKeys({ NODE_ENV: 'production', JWT_SECRET: GOOD_SECRET, ADMIN_PASSWORD: GOOD_ADMIN, SEED_DEMO_DATA: 'true' })
    .includes('SEED_DEMO_DATA'));

check('CORS_ORIGIN=* -> refus',
  fatalKeys({ NODE_ENV: 'production', JWT_SECRET: GOOD_SECRET, ADMIN_PASSWORD: GOOD_ADMIN, CORS_ORIGIN: '*' })
    .includes('CORS_ORIGIN'));

check('CORS_ORIGIN invalide -> refus',
  fatalKeys({ NODE_ENV: 'production', JWT_SECRET: GOOD_SECRET, ADMIN_PASSWORD: GOOD_ADMIN, CORS_ORIGIN: 'pas-une-origine' })
    .includes('CORS_ORIGIN'));

check('sans ADMIN_PASSWORD -> refus',
  fatalKeys({ NODE_ENV: 'production', JWT_SECRET: GOOD_SECRET }).includes('ADMIN_PASSWORD'));

check('mot de passe de demo connu -> refus',
  fatalKeys({ NODE_ENV: 'production', JWT_SECRET: GOOD_SECRET, ADMIN_PASSWORD: 'admin1234' })
    .includes('ADMIN_PASSWORD'));

check('ADMIN_PASSWORD trop court -> refus',
  fatalKeys({ NODE_ENV: 'production', JWT_SECRET: GOOD_SECRET, ADMIN_PASSWORD: 'court1' })
    .includes('ADMIN_PASSWORD'));

section('Production: configuration correcte');

const clean = withEnv(
  { NODE_ENV: 'production', JWT_SECRET: GOOD_SECRET, ADMIN_PASSWORD: GOOD_ADMIN,
    CORS_ORIGIN: 'https://marhba.ma', TRUST_PROXY: '1', ...GOOD_BUSINESS, ...GOOD_SMS,
    ...GOOD_OFFSITE },
  () => inspectEnvironment());
check('aucune erreur bloquante', clean.filter((p) => p.fatal).length === 0,
  clean.filter((p) => p.fatal).map((p) => p.key).join(', '));
check('aucun avertissement', clean.length === 0, clean.map((p) => p.key).join(', '));

section('Mentions legales');

check('mentions incompletes -> refus en production',
  fatalKeys({ NODE_ENV: 'production', JWT_SECRET: GOOD_SECRET, ADMIN_PASSWORD: GOOD_ADMIN,
    CORS_ORIGIN: 'https://marhba.ma', TRUST_PROXY: '1' }).includes('BUSINESS'));

check('un seul champ manquant suffit a refuser',
  fatalKeys({ NODE_ENV: 'production', JWT_SECRET: GOOD_SECRET, ADMIN_PASSWORD: GOOD_ADMIN,
    CORS_ORIGIN: 'https://marhba.ma', TRUST_PROXY: '1',
    ...GOOD_BUSINESS, RC_NUMBER: '' }).includes('BUSINESS'));

const legalDev = withEnv({ ...GOOD_BUSINESS, BUSINESS_NAME: '' }, () => inspectEnvironment());
const legalProblem = legalDev.find((p) => p.key === 'BUSINESS');
check('mentions incompletes -> avertissement en developpement',
  !!legalProblem && legalProblem.fatal === false);
check('le message nomme les champs manquants',
  !!legalProblem && legalProblem.message.includes('BUSINESS_NAME'), legalProblem?.message);

check('mentions completes -> aucun probleme',
  !withEnv({ NODE_ENV: 'production', JWT_SECRET: GOOD_SECRET, ADMIN_PASSWORD: GOOD_ADMIN,
    CORS_ORIGIN: 'https://marhba.ma', TRUST_PROXY: '1', ...GOOD_BUSINESS },
    () => inspectEnvironment()).some((p) => p.key === 'BUSINESS'));

const httpOrigin = withEnv(
  { NODE_ENV: 'production', JWT_SECRET: GOOD_SECRET, ADMIN_PASSWORD: GOOD_ADMIN,
    CORS_ORIGIN: 'http://marhba.ma', TRUST_PROXY: '1', ...GOOD_BUSINESS, ...GOOD_SMS,
    ...GOOD_OFFSITE },
  () => inspectEnvironment());
check('origine en http -> avertissement, pas un refus',
  httpOrigin.length === 1 && !httpOrigin[0].fatal && httpOrigin[0].key === 'CORS_ORIGIN');

const noProxy = withEnv(
  { NODE_ENV: 'production', JWT_SECRET: GOOD_SECRET, ADMIN_PASSWORD: GOOD_ADMIN,
    ...GOOD_BUSINESS, ...GOOD_SMS, ...GOOD_OFFSITE, CORS_ORIGIN: 'https://marhba.ma' },
  () => inspectEnvironment());
check('TRUST_PROXY absent -> avertissement seulement',
  noProxy.every((p) => !p.fatal) && noProxy.some((p) => p.key === 'TRUST_PROXY'));

section('Developpement: les memes problemes ne bloquent pas');

const dev = withEnv({ SEED_DEMO_DATA: 'true' }, () => enforceEnvironment({ exit: false }));
check('demarrage autorise hors production', dev.ok === true);
check('les problemes sont quand meme signales', dev.fatal.length > 0, String(dev.fatal.length));
check('isProduction() faux sans NODE_ENV', withEnv({}, () => isProduction()) === false);
check('isProduction() vrai avec NODE_ENV=production',
  withEnv({ NODE_ENV: 'production' }, () => isProduction()) === true);

section('Production: la sauvegarde hors site');

/*
 * Half a bucket is the dangerous case: the operator fills in two variables,
 * sees no error, and believes copies are leaving the machine. Production must
 * refuse rather than pretend.
 */
const noOffsite = withEnv(
  { NODE_ENV: 'production', JWT_SECRET: GOOD_SECRET, ADMIN_PASSWORD: GOOD_ADMIN,
    CORS_ORIGIN: 'https://marhba.ma', TRUST_PROXY: '1', ...GOOD_BUSINESS, ...GOOD_SMS },
  () => inspectEnvironment());
check('aucune sauvegarde hors site -> avertissement, pas un refus',
  noOffsite.length === 1 && noOffsite[0].key === 'BACKUP_S3' && !noOffsite[0].fatal,
  noOffsite.map((p) => `${p.key}:${p.fatal}`).join(', '));

const halfOffsite = withEnv(
  { NODE_ENV: 'production', JWT_SECRET: GOOD_SECRET, ADMIN_PASSWORD: GOOD_ADMIN,
    CORS_ORIGIN: 'https://marhba.ma', TRUST_PROXY: '1', ...GOOD_BUSINESS, ...GOOD_SMS,
    BACKUP_S3_ENDPOINT: 'https://s3.example.com', BACKUP_S3_BUCKET: 'marhba-sauvegardes' },
  () => inspectEnvironment());
check('configuration hors site a moitie remplie -> refus en production',
  halfOffsite.some((p) => p.key === 'BACKUP_S3' && p.fatal),
  halfOffsite.map((p) => `${p.key}:${p.fatal}`).join(', '));
check('le message nomme ce qui manque',
  (halfOffsite.find((p) => p.key === 'BACKUP_S3') || {}).message?.includes('BACKUP_S3_KEY'),
  (halfOffsite.find((p) => p.key === 'BACKUP_S3') || {}).message);

const halfOffsiteDev = withEnv(
  { BACKUP_S3_ENDPOINT: 'https://s3.example.com' },
  () => inspectEnvironment());
check('a moitie remplie hors production -> simple avertissement',
  halfOffsiteDev.some((p) => p.key === 'BACKUP_S3' && !p.fatal),
  halfOffsiteDev.map((p) => `${p.key}:${p.fatal}`).join(', '));

section('Production: la passerelle SMS');

check('SMS_PROVIDER=console en production -> refus',
  fatalKeys({ NODE_ENV: 'production', JWT_SECRET: GOOD_SECRET, ADMIN_PASSWORD: GOOD_ADMIN,
    ...GOOD_BUSINESS, SMS_PROVIDER: 'console' }).includes('SMS_PROVIDER'));

check('sans SMS_PROVIDER en production -> refus',
  fatalKeys({ NODE_ENV: 'production', JWT_SECRET: GOOD_SECRET, ADMIN_PASSWORD: GOOD_ADMIN,
    ...GOOD_BUSINESS }).includes('SMS_PROVIDER'));

check('infobip sans cle -> refus',
  fatalKeys({ NODE_ENV: 'production', JWT_SECRET: GOOD_SECRET, ADMIN_PASSWORD: GOOD_ADMIN,
    ...GOOD_BUSINESS, SMS_PROVIDER: 'infobip', SMS_API_URL: 'https://x.api.infobip.com' })
    .includes('SMS_PROVIDER'));

check('twilio sans jeton -> refus',
  fatalKeys({ NODE_ENV: 'production', JWT_SECRET: GOOD_SECRET, ADMIN_PASSWORD: GOOD_ADMIN,
    ...GOOD_BUSINESS, SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC1', SMS_SENDER_ID: 'Marhba' })
    .includes('SMS_PROVIDER'));

check('generic_http complet -> accepte',
  !fatalKeys({ NODE_ENV: 'production', JWT_SECRET: GOOD_SECRET, ADMIN_PASSWORD: GOOD_ADMIN,
    ...GOOD_BUSINESS, ...GOOD_SMS, CORS_ORIGIN: 'https://marhba.ma' }).includes('SMS_PROVIDER'));

check('twilio complet -> accepte',
  !fatalKeys({ NODE_ENV: 'production', JWT_SECRET: GOOD_SECRET, ADMIN_PASSWORD: GOOD_ADMIN,
    ...GOOD_BUSINESS, SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC1',
    TWILIO_AUTH_TOKEN: 'jeton', SMS_SENDER_ID: 'Marhba', CORS_ORIGIN: 'https://marhba.ma' })
    .includes('SMS_PROVIDER'));

check('en developpement, console ne bloque rien',
  !fatalKeys({ NODE_ENV: 'development', SMS_PROVIDER: 'console' }).includes('SMS_PROVIDER'));

check('en developpement, une config SMS incomplete est un simple avertissement',
  withEnv({ NODE_ENV: 'development', SMS_PROVIDER: 'infobip' },
    () => inspectEnvironment().some((p) => p.key === 'SMS_PROVIDER' && !p.fatal)));

section('Production: le refus arrete bien le processus');

const stopped = withEnv({ NODE_ENV: 'production' }, () => enforceEnvironment({ exit: false }));
check('enforceEnvironment refuse', stopped.ok === false);
check('les raisons sont listees', stopped.fatal.length >= 2, String(stopped.fatal.length));

console.log(`\n${'-'.repeat(50)}`);
console.log(`  ${pass} tests reussis, ${fail} echecs`);
if (failures.length) console.log(`  Echecs: ${failures.join(' | ')}`);
console.log(`${'-'.repeat(50)}\n`);
process.exit(fail ? 1 : 0);
