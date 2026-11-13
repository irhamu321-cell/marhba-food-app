/* Every interface, on a phone and on a desktop, in French and in Arabic. */
const { chromium } = require('playwright');
const { dismissAddressGate } = require('./_shared.js');
let pass = 0, fail = 0;
const check = (l, ok, extra='') => { ok ? (pass++, console.log('  ok   '+l)) : (fail++, console.log('  FAIL '+l+' '+extra)); };

const SIZES = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'bureau', width: 1360, height: 900 },
];

/** Nothing may stick out sideways: that is what makes a page feel broken. */
async function noOverflow(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    return doc.scrollWidth <= doc.clientWidth + 2;
  });
}

(async () => {
const b = await chromium.launch();

for (const size of SIZES) {
  for (const lang of ['fr', 'ar']) {
    const p = await b.newPage({ viewport: { width: size.width, height: size.height } });
    const errs = [];
    p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

    await p.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
    await dismissAddressGate(p);
    await p.evaluate((l) => localStorage.setItem('food_app_lang', l), lang);
    await p.reload({ waitUntil: 'networkidle' });
    await p.waitForSelector('.resto-card', { timeout: 10000 });

    const dir = await p.evaluate(() => document.documentElement.dir);
    check(`client ${size.name} ${lang}: direction`, dir === (lang === 'ar' ? 'rtl' : 'ltr'), dir);
    check(`client ${size.name} ${lang}: pas de debordement`, await noOverflow(p));
    check(`client ${size.name} ${lang}: cartes affichees`, await p.locator('.resto-card').count() > 0);
    check(`client ${size.name} ${lang}: filtres affiches`, await p.locator('[data-cuisine]').count() > 0);

    // a restaurant page
    await p.locator('.resto-card').first().click();
    await p.waitForTimeout(900);
    check(`resto ${size.name} ${lang}: page ouverte`, (await p.locator('#viewResto').innerText()).length > 40);
    check(`resto ${size.name} ${lang}: pas de debordement`, await noOverflow(p));

    // the restaurant back office
    await p.goto('http://localhost:3000/restaurant.html', { waitUntil: 'networkidle' });
    await p.waitForSelector('#liId', { timeout: 10000 });
    check(`espace resto ${size.name} ${lang}: pas de debordement`, await noOverflow(p));
    await p.fill('#liId', '0611000005');
    await p.fill('#liPass', 'resto1234');
    await p.click('#liBtn');
    await p.waitForSelector('[data-tab]', { timeout: 10000 });
    await p.waitForTimeout(700);
    check(`espace resto ${size.name} ${lang}: onglets`, await p.locator('[data-tab]').count() === 4);
    check(`espace resto ${size.name} ${lang}: contenu sans debordement`, await noOverflow(p));
    await p.click('[data-tab="settings"]');
    await p.waitForTimeout(800);
    check(`reglages resto ${size.name} ${lang}: service configurable`, await p.locator('#svcSwitch').isVisible());
    check(`reglages resto ${size.name} ${lang}: pas de debordement`, await noOverflow(p));

    // the admin panel
    await p.goto('http://localhost:3000/admin.html', { waitUntil: 'networkidle' });
    await p.waitForSelector('#btn', { timeout: 10000 });
    await p.fill('#email', '0600000000');
    await p.fill('#pass', 'admin1234');
    await p.click('#btn');
    await p.waitForSelector('.sidebar', { timeout: 10000 });
    await p.waitForTimeout(900);
    check(`admin ${size.name} ${lang}: pas de debordement`, await noOverflow(p));
    if (size.name === 'mobile') {
      check(`admin ${size.name} ${lang}: menu burger`, await p.locator('#burger').isVisible());
    } else {
      check(`admin ${size.name} ${lang}: barre laterale fixe`, await p.locator('.sidebar').isVisible());
    }

    if (errs.length) { fail += errs.length; console.log(`  ERREURS ${size.name} ${lang}:`, errs.slice(0, 3)); }
    await p.close();
  }
}

console.log(`\n  ${pass} verifications reussies, ${fail} echecs\n`);
await b.close();
process.exit(fail ? 1 : 0);
})();
