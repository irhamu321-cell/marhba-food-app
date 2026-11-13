const { chromium } = require('playwright');
let pass = 0, fail = 0;
const check = (l, ok, extra='') => { ok ? (pass++, console.log('  ok   '+l)) : (fail++, console.log('  FAIL '+l+' '+extra)); };
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1250, height: 1000 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

  await p.goto('http://localhost:3000/admin.html', { waitUntil: 'networkidle' });
  await p.fill('#email', 'admin@demo.ma'); await p.fill('#pass', 'admin1234'); await p.click('#btn');
  await p.waitForTimeout(1600);

  const sections = await p.locator('[data-section]').allTextContents();
  check('15 sections dans l admin', sections.length === 15, String(sections.length));
  check('groupes de navigation', (await p.locator('.navgroup').count()) === 4);

  console.log('\n== Remboursements ==');
  await p.click('[data-section=refunds]');
  await p.waitForTimeout(1300);
  const refundsText = await p.locator('#content').textContent();
  check('vue des remboursements', refundsText.includes('Total rembours'));
  check('au moins un remboursement liste', (await p.locator('#content tbody tr').count()) >= 1,
    String(await p.locator('#content tbody tr').count()));
  check('commande et auteur affiches', refundsText.includes('CMD-'));

  console.log('\n== Commissions ==');
  await p.click('[data-section=commissions]');
  await p.waitForTimeout(1300);
  check('vue commissions', (await p.locator('#content').textContent()).includes('Commission'));

  console.log('\n== Arabe ==');
  await p.click('#langBtn');
  await p.waitForTimeout(1500);
  check('admin en RTL', (await p.getAttribute('html', 'dir')) === 'rtl');
  const navAr = (await p.locator('[data-section]').allTextContents()).join(' ');
  check('navigation traduite', navAr.includes('المطاعم') && navAr.includes('التقارير'), navAr.slice(0, 60));
  await p.click('[data-section=dashboard]');
  await p.waitForTimeout(1400);
  check('tableau de bord en arabe', (await p.locator('#content').textContent()).includes('اليوم'));
  await p.screenshot({ path: '/tmp/z-admin-ar.png', fullPage: true });

  console.log('ERREURS:', errs.length ? errs.slice(0, 4) : 'aucune');
  console.log(`\n  ${pass} verifications reussies, ${fail} echecs\n`);
  await b.close();
  process.exit(fail || errs.length ? 1 : 0);
})();
