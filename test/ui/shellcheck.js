const { chromium } = require('playwright');
(async () => {
let pass = 0, fail = 0;
const check = (l, ok, extra='') => { ok ? (pass++, console.log('  ok   '+l)) : (fail++, console.log('  FAIL '+l+' '+extra)); };
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

await p.goto('http://localhost:3000/admin.html', { waitUntil: 'networkidle' });
check('page de connexion affichee', await p.locator('#btn').isVisible());
await p.fill('#email', '0600000000');
await p.fill('#pass', 'admin1234');
await p.click('#btn');
await p.waitForSelector('.sidebar', { timeout: 10000 });

check('barre laterale visible', await p.locator('.sidebar').isVisible());
const links = await p.locator('.navlink').count();
check('15 entrees de navigation', links === 15, String(links));
check('topbar presente', await p.locator('.topbar2').isVisible());
check('recherche globale presente', await p.locator('#globalSearch').isVisible());
check('bouton notifications', await p.locator('#notifBtn').isVisible());
check('menu compte', await p.locator('#accountBtn').isVisible());
check('section active surlignee', await p.locator('.navlink.active').count() === 1);

// navigate every section
const keys = await p.locator('[data-section]').evaluateAll((n) => n.map((x) => x.dataset.section));
for (const k of keys) {
  await p.click(`[data-section="${k}"]`);
  await p.waitForTimeout(450);
  const filled = (await p.locator('#content').innerText()).trim().length > 10;
  check(`section ${k} s affiche`, filled);
}

// global search
await p.fill('#globalSearch', 'Rest');
await p.waitForTimeout(250);
check('recherche propose des resultats', await p.locator('#searchResults [data-go]').count() > 0);
await p.keyboard.press('Escape');

// notifications popover
await p.click('#notifBtn');
await p.waitForTimeout(200);
check('popover notifications ouvert', await p.locator('#notifPop').isVisible());

// account menu
await p.click('#accountBtn');
await p.waitForTimeout(200);
check('menu compte ouvert', await p.locator('#accountMenu').isVisible());
await p.keyboard.press('Escape');
await p.click('body', { position: { x: 600, y: 400 } });

// mobile drawer
await p.setViewportSize({ width: 390, height: 844 });
await p.waitForTimeout(300);
check('burger visible en mobile', await p.locator('#burger').isVisible());
const hiddenNav = await p.locator('.sidebar').evaluate((el) => el.getBoundingClientRect().left < -50);
check('barre laterale cachee en mobile', hiddenNav);
await p.click('#burger');
await p.waitForTimeout(350);
const openNav = await p.locator('.sidebar').evaluate((el) => el.getBoundingClientRect().left >= -1);
check('tiroir s ouvre en mobile', openNav);
check('voile affiche', await p.locator('.scrim').count() === 1);
await p.locator('.scrim').click({ position: { x: 350, y: 400 } });
await p.waitForTimeout(350);
check('tiroir se ferme', await p.locator('.sidebar').evaluate((el) => el.getBoundingClientRect().left < -50));

// arabic
await p.setViewportSize({ width: 1280, height: 900 });
await p.click('#langBtn');
await p.waitForTimeout(600);
check('direction rtl', await p.evaluate(() => document.documentElement.dir) === 'rtl');
check('barre laterale en arabe', (await p.locator('.navlink').first().innerText()).trim().length > 0);

console.log('ERREURS:', errs.length ? errs.slice(0, 6) : 'aucune');
if (errs.length) fail += errs.length;
console.log(`\n  ${pass} verifications reussies, ${fail} echecs\n`);
await b.close();
process.exit(fail ? 1 : 0);

})();
