const { chromium } = require('playwright');
let pass = 0, fail = 0;
const check = (l, ok, extra='') => { ok ? (pass++, console.log('  ok   '+l)) : (fail++, console.log('  FAIL '+l+' '+extra)); };
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1300, height: 1200 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

  await p.goto('http://localhost:3000/admin.html', { waitUntil: 'networkidle' });
  await p.fill('#email', 'admin@demo.ma'); await p.fill('#pass', 'admin1234'); await p.click('#btn');
  await p.waitForTimeout(1500);

  console.log('\n== Reglages ==');
  await p.click('[data-section=settings]');
  await p.waitForTimeout(1400);
  check('page reglages', await p.locator('#sePlatform').isVisible());
  check('tous les champs presents', await p.locator('#seCommission').isVisible() &&
    await p.locator('#seMaintenance').isVisible() && await p.locator('#sePromos').isVisible());
  await p.fill('#sePlatform', 'Marhba Test UI');
  await p.click('#seSave');
  await p.waitForTimeout(1500);
  check('reglage enregistre', (await p.locator('#sePlatform').inputValue()) === 'Marhba Test UI');
  await p.check('#seMaintenance');
  await p.click('#seSave');
  await p.waitForTimeout(1500);
  check('banniere maintenance affichee', (await p.locator('#content').textContent()).includes('maintenance'));
  await p.uncheck('#seMaintenance');
  await p.click('#seSave');
  await p.waitForTimeout(1400);
  await p.screenshot({ path: '/tmp/z-settings.png', fullPage: true });

  console.log('\n== Journal ==');
  await p.click('[data-section=audit]');
  await p.waitForTimeout(1500);
  check('page journal', await p.locator('#auAction').isVisible());
  check('lignes de journal', (await p.locator('#content tbody tr').count()) >= 3);
  check('colonne changements', (await p.locator('#content').textContent()).includes('Changements'));
  check('details avant/apres', (await p.locator('details').count()) >= 1, String(await p.locator('details').count()));

  await p.selectOption('#auAction', 'settings_update');
  await p.click('#auApply');
  await p.waitForTimeout(1400);
  const filtered = await p.locator('#content tbody tr').count();
  check('filtre par action applique', filtered >= 1, String(filtered));
  const rowsText = await p.locator('#content tbody').textContent();
  check('seules les lignes filtrees', rowsText.includes('settings_update') && !rowsText.includes('order_note'));
  await p.click('#auClear');
  await p.waitForTimeout(1400);
  check('filtres reinitialises', (await p.locator('#content tbody tr').count()) > filtered);
  await p.screenshot({ path: '/tmp/z-audit.png', fullPage: true });

  console.log('ERREURS:', errs.length ? errs.slice(0, 4) : 'aucune');
  console.log(`\n  ${pass} verifications reussies, ${fail} echecs\n`);
  await b.close();
  process.exit(fail || errs.length ? 1 : 0);
})();
