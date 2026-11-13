/* The admin system panel: health, backups, legal warning, codes, events. */
const { chromium } = require('playwright');
let pass = 0, fail = 0;
const check = (l, ok, extra='') => { ok ? (pass++, console.log('  ok   '+l)) : (fail++, console.log('  FAIL '+l+' '+extra)); };

(async () => {
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1320, height: 950 } });
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

await p.goto('http://localhost:3000/admin.html', { waitUntil: 'networkidle' });
await p.fill('#email', '0600000000');
await p.fill('#pass', 'admin1234');
await p.click('#btn');
await p.waitForSelector('.sidebar', { timeout: 10000 });
await p.waitForTimeout(1500);

// the standing banner: the legal details are empty in this environment
check('banniere systeme affichee', await p.locator('#systemBanner .alert').count() > 0);
const bannerText = await p.locator('#systemBanner').innerText();
check('la banniere signale les mentions legales', /legal|l[ée]gal/i.test(bannerText), bannerText.slice(0, 90));

// it follows the admin into another section
await p.click('[data-section="orders"]');
await p.waitForTimeout(1400);
check('la banniere suit dans les autres sections',
  await p.locator('#systemBanner .alert').count() > 0);

await p.click('[data-section="settings"]');
await p.waitForTimeout(2200);
const text = await p.locator('#content').innerText();

check('panneau systeme affiche', /Syst[èe]me/i.test(text), text.slice(0, 80));
check('etat du systeme affiche', /Tout va bien|surveiller|corriger/i.test(text));
check('espace disque affiche', /Mo/.test(text));
check('sauvegardes listees', /Sauvegardes/i.test(text));
/*
 * The panel must show the real number of tables, whatever that number is
 * today. Hard-coding it means this test fails every time the schema grows,
 * which teaches nothing, so the count comes from the API and the panel is
 * checked against it.
 */
const health = await (await fetch('http://localhost:3000/api/admin/health', {
  headers: { Authorization: `Bearer ${await p.evaluate(() => localStorage.getItem('food_app_token'))}` },
})).json();
const tableCount = health.backup && health.backup.tables;
check('l API annonce un nombre de tables', Number(tableCount) > 0, String(tableCount));
check('le panneau affiche le meme nombre de tables',
  new RegExp(`\\b${tableCount}\\b`).test(text), `attendu ${tableCount} dans: ${text.slice(0, 120)}`);
check('consigne de restauration affichee', /restore\.js/.test(text));

/*
 * Whether backups leave the machine has to be visible somewhere, or a daily
 * run can report success for months while nothing has left the building. This
 * environment has no bucket configured, so the panel must say so plainly
 * rather than showing a reassuring blank.
 */
check('le panneau hors site est affiche', /hors site/i.test(text), text.slice(0, 120));
check('l absence de sauvegarde hors site est signalee',
  /Aucune sauvegarde hors site/i.test(text), text.slice(0, 200));
check('les variables a renseigner sont nommees',
  /BACKUP_S3_ENDPOINT/.test(text) && /BACKUP_ENCRYPTION_KEY/.test(text));
check('l API expose l etat hors site',
  typeof health.offsite === 'object' && health.offsite !== null
  && health.offsite.enabled === false,
  JSON.stringify(health.offsite || null).slice(0, 120));
check('l API compte les photos non envoyees',
  typeof health.backup.media_pending === 'number',
  String(health.backup && health.backup.media_pending));
check('mentions legales signalees', /Mentions l[ée]gales/i.test(text));
check('champs manquants listes', /BUSINESS_NAME/.test(text));
check('evenements recents affiches', /[ÉE]v[èé]nements r[ée]cents/i.test(text));

// run a backup from the panel
const before = await p.locator('#content').innerText();
await p.click('#runBackup');
await p.waitForTimeout(2500);
check('sauvegarde lancee depuis le panneau', await p.locator('.toast').count() > 0
  || (await p.locator('#content').innerText()) !== before);
await p.waitForTimeout(2600);

// the pilot code console
await p.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
await p.evaluate(() => fetch('/api/auth/request-code', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ phone: '0699000123' }) }));
await p.waitForTimeout(900);
await p.goto('http://localhost:3000/admin.html', { waitUntil: 'networkidle' });
await p.waitForSelector('.sidebar', { timeout: 10000 });
await p.click('[data-section="settings"]');
await p.waitForTimeout(2400);
const withCode = await p.locator('#content').innerText();
check('les codes en cours sont visibles pour l admin', /0699000123/.test(withCode),
  withCode.slice(0, 120));
check('le code a six chiffres est affiche', /\b\d{6}\b/.test(withCode));

console.log('ERREURS:', errs.length ? errs.slice(0, 5) : 'aucune');
if (errs.length) fail += errs.length;
console.log(`\n  ${pass} verifications reussies, ${fail} echecs\n`);
await b.close();
process.exit(fail ? 1 : 0);
})();
