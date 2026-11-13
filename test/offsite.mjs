/*
 * Off-site backups: the encryption and the S3 signature.
 *
 * Both are the kind of code that looks right and is wrong, and whose failure
 * only shows up the day you need the backup. So the round trip is checked in
 * both directions, tampering is checked to fail, and the signature is checked
 * byte for byte against a request built by hand rather than against itself.
 */
process.env.NODE_ENV = 'test';

import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';

import {
  encryptBuffer, decryptBuffer, signPut, objectKeyFor, offsiteEnabled,
  missingOffsiteConfig, uploadBackupFile, pushOffsite, offsiteState,
  pendingUploads, pushUploads, readUploadLedger, writeUploadLedger, uploadsLedgerPath,
} from '../server/src/offsite.js';

let pass = 0, fail = 0;
const check = (label, ok, extra = '') => {
  ok ? (pass++, console.log('  ok   ' + label)) : (fail++, console.log('  FAIL ' + label + ' ' + extra));
};

const CONFIG = {
  endpoint: 'https://abc123.r2.cloudflarestorage.com',
  bucket: 'marhba-backups',
  key: 'AKIAIOSFODNN7EXAMPLE',
  secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'auto',
  prefix: 'marhba',
  passphrase: 'une-phrase-de-passe-vraiment-longue',
};

const dir = mkdtempSync(join(tmpdir(), 'offsite-'));

console.log('\n== Chiffrement ==');
{
  const plain = Buffer.from('des donnees de clients: 0612345678, Rue de Fes', 'utf8');
  const archive = encryptBuffer(plain, CONFIG.passphrase);

  check('l archive commence par sa signature',
    archive.subarray(0, 5).toString('latin1') === 'MRHB1',
    archive.subarray(0, 5).toString('latin1'));
  check('l archive ne contient pas le texte en clair',
    !archive.includes(Buffer.from('0612345678')), 'le numero est lisible dans l archive');
  check('l archive est plus longue que l original', archive.length > plain.length);
  check('le dechiffrement rend exactement l original',
    decryptBuffer(archive, CONFIG.passphrase).equals(plain));

  // Two encryptions of the same bytes must differ: a fresh salt and nonce.
  const again = encryptBuffer(plain, CONFIG.passphrase);
  check('deux chiffrements du meme contenu different', !again.equals(archive));
  check('les deux se dechiffrent quand meme',
    decryptBuffer(again, CONFIG.passphrase).equals(plain));

  let message = '';
  try { decryptBuffer(archive, 'mauvaise-phrase'); } catch (e) { message = e.message; }
  check('une mauvaise phrase de passe echoue', message.length > 0, message);

  // GCM: a single flipped byte must fail, not decrypt to something wrong.
  const tampered = Buffer.from(archive);
  tampered[tampered.length - 1] ^= 0xff;
  let tamperError = '';
  try { decryptBuffer(tampered, CONFIG.passphrase); } catch (e) { tamperError = e.message; }
  check('une archive modifiee est refusee, pas restauree', tamperError.length > 0, tamperError);

  const notOurs = Buffer.concat([Buffer.from('ZZZZZ'), crypto.randomBytes(60)]);
  let wrongMagic = '';
  try { decryptBuffer(notOurs, CONFIG.passphrase); } catch (e) { wrongMagic = e.message; }
  check('un fichier etranger est reconnu comme tel',
    /archive Marhba/.test(wrongMagic), wrongMagic);

  let tooShort = '';
  try { decryptBuffer(Buffer.from('MRHB1'), CONFIG.passphrase); } catch (e) { tooShort = e.message; }
  check('une archive tronquee est refusee', /courte/.test(tooShort), tooShort);

  let noKey = '';
  try { encryptBuffer(plain, ''); } catch (e) { noKey = e.message; }
  check('chiffrer sans cle est refuse', /BACKUP_ENCRYPTION_KEY/.test(noKey), noKey);

  // A megabyte, to be sure nothing is truncated at a buffer boundary.
  const big = crypto.randomBytes(1024 * 1024);
  check('un fichier d un megaoctet fait l aller-retour',
    decryptBuffer(encryptBuffer(big, CONFIG.passphrase), CONFIG.passphrase).equals(big));
}

console.log('\n== Configuration ==');
check('tout renseigne = active', offsiteEnabled(CONFIG) === true);
check('rien renseigne = inactif',
  offsiteEnabled({ endpoint: '', bucket: '', key: '', secret: '' }) === false);
check('sans bucket = inactif', offsiteEnabled({ ...CONFIG, bucket: '' }) === false);
check('les manques sont nommes',
  missingOffsiteConfig({ ...CONFIG, secret: '', passphrase: '' })
    .join(',') === 'BACKUP_S3_SECRET,BACKUP_ENCRYPTION_KEY',
  missingOffsiteConfig({ ...CONFIG, secret: '', passphrase: '' }).join(','));
check('une configuration complete ne manque de rien',
  missingOffsiteConfig(CONFIG).length === 0);

console.log('\n== Le chemin dans le bucket ==');
{
  const now = new Date('2026-11-03T04:05:06Z');
  const key = objectKeyFor('backup-2026-11-03.db', { prefix: 'marhba', now });
  check('le fichier est range par mois', key === 'marhba/2026-11/backup-2026-11-03.db.enc', key);
  check('l extension .enc est ajoutee', key.endsWith('.enc'));
  check('sans prefixe, pas de slash en tete',
    !objectKeyFor('x.db', { prefix: '', now }).startsWith('/'),
    objectKeyFor('x.db', { prefix: '', now }));
}

console.log('\n== La signature AWS V4 ==');
{
  const now = new Date('2026-11-03T04:05:06Z');
  const body = Buffer.from('contenu');
  const signed = signPut({ config: CONFIG, objectKey: 'marhba/2026-11/x.db.enc', body, now });

  check('l url est construite',
    signed.url === 'https://abc123.r2.cloudflarestorage.com/marhba-backups/marhba/2026-11/x.db.enc',
    signed.url);
  check('la date est au format AWS',
    signed.headers['x-amz-date'] === '20261103T040506Z', signed.headers['x-amz-date']);
  check('le hachage du contenu est envoye',
    signed.headers['x-amz-content-sha256']
      === crypto.createHash('sha256').update(body).digest('hex'));
  check('l en-tete d autorisation nomme l algorithme',
    signed.headers.Authorization.startsWith('AWS4-HMAC-SHA256 Credential='));
  check('la portee contient la date, la region et s3',
    signed.headers.Authorization.includes('/20261103/auto/s3/aws4_request'),
    signed.headers.Authorization.slice(0, 120));
  check('les en-tetes signes sont listes dans l ordre',
    signed.headers.Authorization.includes(
      'SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date'),
    signed.headers.Authorization);
  check('la cle secrete n apparait nulle part',
    !JSON.stringify(signed.headers).includes(CONFIG.secret));

  /*
   * The signature, recomputed here from the documented steps rather than by
   * calling the same function again. If signPut ever changes shape, this
   * fails — which is the point.
   */
  const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
  const hmac = (k, v) => crypto.createHmac('sha256', k).update(v).digest();
  const canonical = [
    'PUT',
    '/marhba-backups/marhba/2026-11/x.db.enc',
    '',
    'content-type:application/octet-stream\n'
      + `host:abc123.r2.cloudflarestorage.com\n`
      + `x-amz-content-sha256:${sha(body)}\n`
      + 'x-amz-date:20261103T040506Z\n',
    'content-type;host;x-amz-content-sha256;x-amz-date',
    sha(body),
  ].join('\n');
  check('la requete canonique est celle attendue',
    signed.canonicalRequest === canonical,
    JSON.stringify(signed.canonicalRequest).slice(0, 200));

  const toSign = ['AWS4-HMAC-SHA256', '20261103T040506Z',
    '20261103/auto/s3/aws4_request', sha(canonical)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${CONFIG.secret}`, '20261103'), 'auto'), 's3'), 'aws4_request');
  const expected = crypto.createHmac('sha256', signingKey).update(toSign).digest('hex');
  check('la signature correspond au calcul independant',
    signed.headers.Authorization.endsWith(`Signature=${expected}`),
    signed.headers.Authorization.slice(-80));

  // A different body must produce a different signature.
  const other = signPut({ config: CONFIG, objectKey: 'marhba/2026-11/x.db.enc',
    body: Buffer.from('autre'), now });
  check('un contenu different change la signature',
    other.headers.Authorization !== signed.headers.Authorization);
  const laterDay = signPut({ config: CONFIG, objectKey: 'marhba/2026-11/x.db.enc',
    body, now: new Date('2026-11-04T04:05:06Z') });
  check('un jour different change la signature',
    laterDay.headers.Authorization !== signed.headers.Authorization);
}

console.log('\n== L envoi ==');
function fakeFetch({ ok = true, status = 200, body = '', throws = null } = {}) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    if (throws) throw new Error(throws);
    return { ok, status, text: async () => body };
  };
  impl.calls = calls;
  return impl;
}

const dbPath = join(dir, 'backup-2026-11-03.db');
const jsonPath = join(dir, 'backup-2026-11-03.json');
writeFileSync(dbPath, Buffer.concat([Buffer.from('SQLite format 3\0'), crypto.randomBytes(2048)]));
writeFileSync(jsonPath, JSON.stringify({ users: [{ phone: '0612345678' }] }));

{
  const impl = fakeFetch();
  const result = await uploadBackupFile(dbPath, { config: CONFIG, fetchImpl: impl,
    now: new Date('2026-11-03T04:05:06Z') });
  check('un seul PUT est fait', impl.calls.length === 1);
  check('la methode est PUT', impl.calls[0].options.method === 'PUT');
  check('la cle de l objet est rapportee',
    result.key === 'marhba/2026-11/backup-2026-11-03.db.enc', result.key);
  check('le corps envoye est chiffre',
    impl.calls[0].options.body.subarray(0, 5).toString('latin1') === 'MRHB1');
  check('le corps envoye se dechiffre',
    decryptBuffer(impl.calls[0].options.body, CONFIG.passphrase).length === 2064,
    String(decryptBuffer(impl.calls[0].options.body, CONFIG.passphrase).length));
  check('la taille chiffree est rapportee', result.bytes === impl.calls[0].options.body.length);
}
{
  const impl = fakeFetch();
  let message = '';
  try {
    await uploadBackupFile(join(dir, 'absent.db'), { config: CONFIG, fetchImpl: impl });
  } catch (e) { message = e.message; }
  check('un fichier absent est refuse avant tout appel',
    /introuvable/.test(message) && impl.calls.length === 0, message);
}
{
  let message = '';
  try {
    await uploadBackupFile(dbPath, { config: { ...CONFIG, bucket: '' }, fetchImpl: fakeFetch() });
  } catch (e) { message = e.message; }
  check('une configuration incomplete est refusee', /non configure/.test(message), message);
}
{
  let message = '';
  try {
    await uploadBackupFile(dbPath, { config: { ...CONFIG, passphrase: '' }, fetchImpl: fakeFetch() });
  } catch (e) { message = e.message; }
  check('sans cle de chiffrement, rien ne part',
    /BACKUP_ENCRYPTION_KEY/.test(message), message);
}

console.log('\n== Les deux fichiers du jour, et les echecs ==');
{
  const impl = fakeFetch();
  const audits = [];
  const result = await pushOffsite([dbPath, jsonPath], {
    config: CONFIG, fetchImpl: impl, now: new Date('2026-11-03T04:05:06Z'),
    audit: async (entry) => audits.push(entry),
  });
  check('les deux fichiers partent', result.uploaded.length === 2, String(result.uploaded.length));
  check('aucun echec', result.failed.length === 0);
  check('une ligne d audit est ecrite', audits.length === 1);
  check('l audit nomme l action', audits[0].action === 'backup_offsite', audits[0].action);
  check('l audit liste les cles envoyees',
    audits[0].details.uploaded.length === 2, JSON.stringify(audits[0].details).slice(0, 120));
}
{
  const impl = fakeFetch({ ok: false, status: 403, body: 'SignatureDoesNotMatch' });
  const audits = [];
  const before = offsiteState.failures;
  const result = await pushOffsite([dbPath], {
    config: CONFIG, fetchImpl: impl, audit: async (entry) => audits.push(entry) });
  check('un refus du stockage est rapporte, pas jete', result.failed.length === 1);
  check('le motif du stockage est conserve',
    /403|SignatureDoesNotMatch/.test(result.failed[0].error), result.failed[0].error);
  check('l echec est compte', offsiteState.failures === before + 1);
  check('l audit enregistre l echec',
    audits[0].action === 'backup_offsite_failed', audits[0] && audits[0].action);
}
{
  const impl = fakeFetch({ throws: 'ENOTFOUND' });
  const result = await pushOffsite([dbPath], { config: CONFIG, fetchImpl: impl });
  check('un stockage injoignable est rapporte, pas jete', result.failed.length === 1);
}
{
  const impl = fakeFetch();
  const result = await pushOffsite([dbPath], {
    config: { endpoint: '', bucket: '', key: '', secret: '', passphrase: '' }, fetchImpl: impl });
  check('non configure: rien n est tente',
    result.skipped === true && impl.calls.length === 0);
}

/* ------------------------------------------------------------------ *
 * The photos
 *
 * A database-only backup restores every menu with every picture broken, and
 * says nothing is wrong, because as far as the database is concerned nothing
 * is. These checks are about the media going too, exactly once each.
 * ------------------------------------------------------------------ */
console.log('\n== Les photos, envoyees une seule fois ==');

const mediaDir = join(dir, 'uploads');
mkdirSync(mediaDir, { recursive: true });
const ledger = join(dir, 'ledger.json');
writeFileSync(join(mediaDir, 'aaa.png'), Buffer.from('faux-png-1'));
writeFileSync(join(mediaDir, 'bbb.jpg'), Buffer.from('faux-jpg-2'));
writeFileSync(join(mediaDir, 'notes.txt'), Buffer.from('pas une image'));
writeFileSync(join(mediaDir, '.gitkeep'), Buffer.from(''));

{
  const pending = pendingUploads(mediaDir, ledger);
  check('les images sont a envoyer', pending.length === 2, String(pending.length));
  check('ce qui n est pas une image est ignore',
    !pending.some((f) => f.endsWith('.txt') || f.endsWith('.gitkeep')),
    pending.join(', '));
}
check('un dossier absent ne casse rien',
  pendingUploads(join(dir, 'nulle-part'), ledger).length === 0);

{
  const impl = fakeFetch();
  const result = await pushUploads(mediaDir, ledger, { config: CONFIG, fetchImpl: impl });
  check('les deux images partent', result.uploaded.length === 2, String(result.uploaded.length));
  check('elles sont rangees sous uploads/',
    result.uploaded.every((u) => u.key.includes('/uploads/')),
    result.uploaded.map((u) => u.key).join(', '));
  check('elles ne sont pas classees par mois',
    !result.uploaded.some((u) => /\/\d{4}-\d{2}\//.test(u.key)),
    result.uploaded.map((u) => u.key).join(', '));
  check('elles sont chiffrees comme le reste',
    result.uploaded.every((u) => u.key.endsWith('.enc')));
  check('le registre est ecrit', existsSync(ledger));
  check('le registre nomme les deux fichiers',
    readUploadLedger(ledger).size === 2, String(readUploadLedger(ledger).size));
}

check('plus rien n est en attente', pendingUploads(mediaDir, ledger).length === 0);

{
  const impl = fakeFetch();
  const result = await pushUploads(mediaDir, ledger, { config: CONFIG, fetchImpl: impl });
  check('une deuxieme nuit n envoie rien', result.uploaded.length === 0 && impl.calls.length === 0);
}

writeFileSync(join(mediaDir, 'ccc.webp'), Buffer.from('faux-webp-3'));
{
  const impl = fakeFetch();
  const result = await pushUploads(mediaDir, ledger, { config: CONFIG, fetchImpl: impl });
  check('une nouvelle image part seule',
    result.uploaded.length === 1 && result.uploaded[0].file === 'ccc.webp',
    result.uploaded.map((u) => u.file).join(', '));
}

// a failure must not be remembered as a success, or the file is lost for good
writeFileSync(join(mediaDir, 'ddd.png'), Buffer.from('faux-png-4'));
{
  const impl = fakeFetch({ ok: false, status: 500, body: 'refus du stockage' });
  const result = await pushUploads(mediaDir, ledger, { config: CONFIG, fetchImpl: impl });
  check('un envoi echoue est rapporte', result.failed.length === 1, JSON.stringify(result.failed));
  check('un envoi echoue n entre pas au registre',
    !readUploadLedger(ledger).has('ddd.png'));
}
{
  const impl = fakeFetch();
  const result = await pushUploads(mediaDir, ledger, { config: CONFIG, fetchImpl: impl });
  check('il repart la nuit suivante',
    result.uploaded.length === 1 && result.uploaded[0].file === 'ddd.png',
    result.uploaded.map((u) => u.file).join(', '));
}

{
  const impl = fakeFetch();
  const result = await pushUploads(mediaDir, ledger, {
    config: { endpoint: '', bucket: '', key: '', secret: '', passphrase: '' }, fetchImpl: impl });
  check('sans stockage configure, rien n est tente', impl.calls.length === 0);
}

check('un registre illisible se comporte comme un registre vide',
  readUploadLedger(join(dir, 'inexistant.json')).size === 0);
check('le chemin du registre est a cote de la base',
  uploadsLedgerPath('/racine').replace(/\\/g, '/') === '/racine/data/offsite-uploads.json',
  uploadsLedgerPath('/racine'));

rmSync(dir, { recursive: true, force: true });
console.log(`\n  ${pass} tests reussis, ${fail} echecs\n`);
process.exit(fail ? 1 : 0);
