const { chromium } = require('playwright');
let pass = 0, fail = 0;
const check = (l, ok, extra='') => { ok ? (pass++, console.log('  ok   '+l)) : (fail++, console.log('  FAIL '+l+' '+extra)); };
const unique = String(Date.now()).slice(-6);
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
  await p.click('[data-section=staff]');
  await p.waitForTimeout(1400);

  check('page equipe', await p.locator('#stName').isVisible());
  check('membres listes', (await p.locator('#content tbody tr').count()) >= 1);
  check('selecteur de role par membre', (await p.locator('[data-role]').count()) >= 1);

  await p.fill('#stName', `Operateur ${unique}`);
  await p.fill('#stPhone', `075${unique}0`);
  await p.fill('#stPass', 'motdepasse1');
  await p.selectOption('#stRole', 'operations');
  await p.click('#stAdd');
  await p.waitForTimeout(1600);
  check('membre cree depuis l interface', (await p.locator('#content').textContent()).includes(`Operateur ${unique}`));
  await p.screenshot({ path: '/tmp/z-staff.png', fullPage: true });

  const row = p.locator('tr', { hasText: `Operateur ${unique}` });
  await row.locator('[data-role]').selectOption('finance');
  await p.waitForTimeout(1600);
  check('role modifie', (await p.locator('tr', { hasText: `Operateur ${unique}` }).locator('[data-role]').inputValue()) === 'finance');

  await p.locator('tr', { hasText: `Operateur ${unique}` }).locator('[data-ststatus]').click();
  await p.waitForTimeout(1600);
  check('membre desactive', (await p.locator('tr', { hasText: `Operateur ${unique}` }).textContent()).includes('Suspendu'));

  await p.locator('[data-stactions]').first().click();
  await p.waitForTimeout(1300);
  check('actions recentes affichees', (await p.locator('#staffActions').textContent()).length > 10);

  // a finance admin must not see the staff section at all
  const p2 = await b.newPage({ viewport: { width: 1250, height: 900 } });
  p2.on('pageerror', (e) => errs.push('finance: ' + e.message));
  await p2.goto('http://localhost:3000/admin.html', { waitUntil: 'networkidle' });
  await p2.fill('#email', `075${unique}0`);
  await p2.fill('#pass', 'motdepasse1');
  await p2.click('#btn');
  await p2.waitForTimeout(1500);
  const blocked = await p2.locator('#content').textContent().catch(() => '');
  check('compte desactive ne peut pas entrer', !(await p2.locator('[data-section]').count()),
    blocked.slice(0, 50));

  console.log('ERREURS:', errs.length ? errs.slice(0, 4) : 'aucune');
  console.log(`\n  ${pass} verifications reussies, ${fail} echecs\n`);
  await b.close();
  process.exit(fail || errs.length ? 1 : 0);
})();
