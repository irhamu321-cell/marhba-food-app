/* The legal pages: every page, both languages, and the incomplete warning. */
const { chromium } = require('playwright');
const { dismissAddressGate } = require('./_shared.js');
let pass = 0, fail = 0;
const check = (l, ok, extra='') => { ok ? (pass++, console.log('  ok   '+l)) : (fail++, console.log('  FAIL '+l+' '+extra)); };

const PAGES = ['about', 'terms', 'privacy', 'cookies', 'cod', 'retention', 'contact'];

(async () => {
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 420, height: 900 } });
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

for (const lang of ['fr', 'ar']) {
  await p.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
  await dismissAddressGate(p);
  await p.evaluate((l) => localStorage.setItem('food_app_lang', l), lang);
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForSelector('.resto-card', { timeout: 10000 });

  await p.click('#navHelp');
  await p.waitForTimeout(700);
  const links = await p.locator('[data-legal]').count();
  check(`${lang}: les 7 pages legales sont proposees`, links >= 7, String(links));

  await p.locator('[data-legal="about"]').first().click();
  await p.waitForTimeout(800);

  for (const page of PAGES) {
    await p.locator(`[data-legalnav="${page}"]`).click();
    await p.waitForTimeout(400);
    const text = await p.locator('#viewLegal').innerText();
    check(`${lang}: page ${page} affichee`, text.length > 200, String(text.length));
    check(`${lang}: page ${page} a des titres de section`,
      await p.locator('#viewLegal h3').count() > 0);
  }

  // The identity is empty in the test environment: the warning must be shown.
  await p.locator('[data-legalnav="about"]').click();
  await p.waitForTimeout(400);
  const aboutText = await p.locator('#viewLegal').innerText();
  check(`${lang}: avertissement mentions incompletes`,
    await p.locator('#viewLegal .alert.warn').count() === 1);
  check(`${lang}: les valeurs manquantes sont visibles`,
    /\[/.test(aboutText), aboutText.slice(0, 80));

  // The privacy page must never claim a CNDP approval it does not have.
  await p.locator('[data-legalnav="privacy"]').click();
  await p.waitForTimeout(400);
  const privacy = await p.locator('#viewLegal').innerText();
  check(`${lang}: la CNDP est citee`, /CNDP/i.test(privacy));
  check(`${lang}: aucune approbation CNDP revendiquee`,
    !/approuv|approbation accord|مصادق/i.test(privacy), privacy.slice(0, 60));
  check(`${lang}: les durees de conservation sont indiquees`,
    /10|12|24/.test(privacy));

  // The cash page must explain who refunds.
  await p.locator('[data-legalnav="cod"]').click();
  await p.waitForTimeout(400);
  const cod = await p.locator('#viewLegal').innerText();
  check(`${lang}: le remboursement est explique`, cod.length > 300, String(cod.length));
}

console.log('ERREURS:', errs.length ? errs.slice(0, 5) : 'aucune');
if (errs.length) fail += errs.length;
console.log(`\n  ${pass} verifications reussies, ${fail} echecs\n`);
await b.close();
process.exit(fail ? 1 : 0);
})();
