const { chromium } = require('playwright');
let pass = 0, fail = 0;
const check = (l, ok, extra='') => { ok ? (pass++, console.log('  ok   '+l)) : (fail++, console.log('  FAIL '+l+' '+extra)); };
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1250, height: 1100 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  p.on('dialog', async (d) => { await d.accept(); });

  await p.goto('http://localhost:3000/admin.html', { waitUntil: 'networkidle' });
  await p.fill('#email', 'admin@demo.ma'); await p.fill('#pass', 'admin1234'); await p.click('#btn');
  await p.waitForTimeout(1500);
  await p.click('[data-section=customers]');
  await p.waitForTimeout(1400);
  check('liste des comptes', (await p.locator('[data-profile]').count()) >= 3);
  await p.fill('#uSearch', 'Client Demo');
  await p.click('#uSearchBtn');
  await p.waitForTimeout(1200);
  check('recherche par nom', (await p.locator('#content tbody tr').count()) === 1);

  await p.locator('[data-profile]').first().click();
  await p.waitForTimeout(1400);
  const prof = await p.locator('#content').textContent();
  check('fiche client ouverte', prof.includes('Historique des commandes'));
  check('statistiques client', (await p.locator('.stat').count()) === 6, String(await p.locator('.stat').count()));
  check('boutons de gestion', (await p.locator('[data-ustatus]').count()) === 1);
  await p.screenshot({ path: '/tmp/z-customer.png', fullPage: true });

  await p.locator('[data-ustatus]').first().click();
  await p.waitForTimeout(1400);
  check('suspension depuis la fiche', (await p.locator('#content').textContent()).includes('Suspendu'));
  await p.locator('[data-ustatus]').first().click();
  await p.waitForTimeout(1400);
  check('reactivation depuis la fiche', (await p.locator('#content').textContent()).includes('Actif'));

  await p.click('#backCustomers');
  await p.waitForTimeout(1100);
  check('retour a la liste', await p.locator('#uSearch').isVisible());

  console.log('ERREURS:', errs.length ? errs.slice(0, 4) : 'aucune');
  console.log(`\n  ${pass} verifications reussies, ${fail} echecs\n`);
  await b.close();
  process.exit(fail || errs.length ? 1 : 0);
})();
