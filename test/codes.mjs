/*
 * One-time codes: expiry, reuse, wrong guesses, brute force, rate limiting.
 * Runs on its own temporary database.
 *
 *   node test/codes.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workdir = mkdtempSync(join(tmpdir(), 'marhba-codes-'));
process.env.DB_PATH = join(workdir, 'codes.db');
process.env.SEED_DEMO_DATA = 'false';
process.env.LOG_LEVEL = 'error';
process.env.OTP_CONSOLE = 'true';

const { connectStore, store, nowIso } = await import('../server/src/store.js');
const { createSchema } = await import('../server/src/schema.js');
const codes = await import('../server/src/codes.js');
const { issueCode, consumeCode, setDelivery, pendingCodes, purgeCodes, _internals } = codes;

let pass = 0, fail = 0;
const failures = [];
const check = (label, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(label); console.log(`  FAIL ${label} ${extra}`); }
};
const section = (name) => console.log(`\n== ${name} ==`);

/** Captures the delivered code instead of printing it. */
let delivered = null;
setDelivery(async (payload) => { delivered = payload; return { transport: 'test' }; });

const issue = async (destination, purpose = 'register') => {
  delivered = null;
  const result = await issueCode({ purpose, channel: 'phone', destination, ip: '10.0.0.1' });
  return { result, code: delivered.code };
};

/** Moves a code's expiry into the past, without waiting five minutes. */
async function expire(destination, purpose = 'register') {
  await store.run(
    `UPDATE auth_codes SET expires_at = $1
     WHERE purpose = $2 AND destination = $3 AND consumed_at IS NULL`,
    [new Date(Date.now() - 60_000).toISOString(), purpose, destination]);
}

try {
  await connectStore();
  await createSchema();

  section('Emission');
  const first = await issue('0600000101');
  check('un code est emis', first.result.sent === true);
  check('le code fait six chiffres', /^\d{6}$/.test(first.code), first.code);
  check('la reponse ne contient jamais le code',
    !JSON.stringify(first.result).includes(first.code), JSON.stringify(first.result));
  check('duree de validite annoncee', first.result.expires_in_minutes === 5,
    String(first.result.expires_in_minutes));

  const stored = await store.get(
    "SELECT * FROM auth_codes WHERE destination = '0600000101' ORDER BY id DESC LIMIT 1");
  check('seul un hachage est stocke', stored.code_hash.startsWith('scrypt$'), stored.code_hash.slice(0, 12));
  check('le code en clair n est pas stocke', !stored.code_hash.includes(first.code));

  section('Code correct');
  const good = await consumeCode({ purpose: 'register', destination: '0600000101', code: first.code });
  check('le bon code est accepte', good.ok === true, good.reason);

  section('Usage unique');
  const again = await consumeCode({ purpose: 'register', destination: '0600000101', code: first.code });
  check('un code deja utilise est refuse', again.ok === false && again.reason === 'consumed', again.reason);

  section('Expiration');
  const second = await issue('0600000102');
  await expire('0600000102');
  const stale = await consumeCode({ purpose: 'register', destination: '0600000102', code: second.code });
  check('un code expire est refuse', stale.ok === false && stale.reason === 'expired', stale.reason);

  section('Code invalide');
  const third = await issue('0600000103');
  const wrong = await consumeCode({ purpose: 'register', destination: '0600000103', code: '000000' });
  check('un mauvais code est refuse', wrong.ok === false && wrong.reason === 'wrong', wrong.reason);
  check('l essai est compte', wrong.attempts === 1, String(wrong.attempts));
  const stillGood = await consumeCode({ purpose: 'register', destination: '0600000103', code: third.code });
  check('le bon code marche encore apres un essai rate', stillGood.ok === true, stillGood.reason);

  section('Force brute');
  const fourth = await issue('0600000104');
  let lastReason = '';
  for (let i = 0; i < _internals.MAX_ATTEMPTS; i += 1) {
    const attempt = await consumeCode({ purpose: 'register', destination: '0600000104', code: '111111' });
    lastReason = attempt.reason;
  }
  check(`bloque apres ${_internals.MAX_ATTEMPTS} essais`, lastReason === 'too_many', lastReason);
  const burned = await consumeCode({ purpose: 'register', destination: '0600000104', code: fourth.code });
  check('le vrai code ne marche plus apres la force brute',
    burned.ok === false && burned.reason === 'consumed', burned.reason);

  section('Un seul code vivant a la fois');
  const old = await issue('0600000105');
  const fresh = await issue('0600000105');
  const replaced = await consumeCode({ purpose: 'register', destination: '0600000105', code: old.code });
  check('l ancien code est invalide', replaced.ok === false, replaced.reason);
  const newest = await consumeCode({ purpose: 'register', destination: '0600000105', code: fresh.code });
  check('le dernier code fonctionne', newest.ok === true, newest.reason);

  section('Limitation du nombre de demandes');
  const target = '0600000106';
  for (let i = 0; i < _internals.REQUEST_LIMIT; i += 1) await issue(target);
  let limited = false;
  let limitStatus = 0;
  try { await issue(target); }
  catch (error) { limited = true; limitStatus = error.status; }
  check(`bloque apres ${_internals.REQUEST_LIMIT} demandes`, limited, 'aucune erreur levee');
  check('refus avec le statut 429', limitStatus === 429, String(limitStatus));

  section('Destinations separees');
  const other = await issue('0600000107');
  check('une autre destination n est pas affectee', other.result.sent === true);
  const crossed = await consumeCode({ purpose: 'register', destination: '0600000107', code: first.code });
  check('un code ne marche pas sur une autre destination', crossed.ok === false, crossed.reason);

  section('Les usages ne se melangent pas');
  const resetCode = await issue('0600000108', 'reset');
  check('un code de reinitialisation dure 15 minutes',
    resetCode.result.expires_in_minutes === 15, String(resetCode.result.expires_in_minutes));
  const wrongPurpose = await consumeCode({
    purpose: 'register', destination: '0600000108', code: resetCode.code });
  check('un code reset ne vaut pas pour une inscription', wrongPurpose.ok === false, wrongPurpose.reason);

  section('Console pilote');
  const visible = pendingCodes();
  check('les codes vivants sont visibles pour l admin', visible.length > 0, String(visible.length));
  check('chaque entree porte sa destination', visible.every((entry) => !!entry.destination));

  section('Nettoyage');
  await store.run(
    `INSERT INTO auth_codes (purpose, channel, destination, code_hash, expires_at, created_ip, created_at)
     VALUES ('register','phone','0600000199','scrypt$a$b',$1,'','')`,
    [new Date(Date.now() - 2 * 86_400_000).toISOString()]);
  await purgeCodes();
  const leftover = await store.get(
    "SELECT COUNT(*) AS c FROM auth_codes WHERE destination = '0600000199'");
  check('les vieux codes sont supprimes', Number(leftover.c) === 0, String(leftover.c));

  await store.close();
} catch (error) {
  console.error('Erreur du test:', error);
  fail++;
} finally {
  rmSync(workdir, { recursive: true, force: true });
}

console.log(`\n${'-'.repeat(50)}`);
console.log(`  ${pass} tests reussis, ${fail} echecs`);
if (failures.length) console.log(`  Echecs: ${failures.join(' | ')}`);
console.log(`${'-'.repeat(50)}\n`);
process.exit(fail ? 1 : 0);
