const { chromium } = require('playwright');
let pass = 0, fail = 0;
const check = (l, ok, extra='') => { ok ? (pass++, console.log('  ok   '+l)) : (fail++, console.log('  FAIL '+l+' '+extra)); };
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1250, height: 1100 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  let answer = 'Note de test';
  p.on('dialog', async (d) => { await d.accept(answer); });

  await p.goto('http://localhost:3000/admin.html', { waitUntil: 'networkidle' });
  await p.fill('#email', 'admin@demo.ma'); await p.fill('#pass', 'admin1234'); await p.click('#btn');
  await p.waitForTimeout(1500);
  await p.click('[data-section=orders]');
  await p.waitForTimeout(1300);

  check('page commandes', (await p.locator('[data-order]').count()) >= 1);
  check('filtres presents', await p.locator('#fstatus').isVisible() && await p.locator('#ffrom').isVisible());
  check('totaux affiches', (await p.locator('.stat').count()) === 4);

  const before = await p.locator('[data-order]').count();
  await p.selectOption('#fstatus', 'completed');
  await p.click('#applyFilters');
  await p.waitForTimeout(1200);
  const after = await p.locator('[data-order]').count();
  check(`filtre statut applique (${before} -> ${after})`, after <= before && after >= 1);

  await p.selectOption('#fstatus', 'refunded');
  await p.click('#applyFilters');
  await p.waitForTimeout(1200);
  check('filtre rembourses', (await p.locator('#content').textContent()).includes('MAD'));

  await p.click('#clearFilters');
  await p.waitForTimeout(1200);
  await p.fill('#fq', 'CMD-');
  await p.click('#applyFilters');
  await p.waitForTimeout(1200);
  check('recherche texte', (await p.locator('[data-order]').count()) >= 1);

  await p.locator('[data-order]').first().click();
  await p.waitForTimeout(1300);
  const detail = await p.locator('#content').textContent();
  check('fiche commande ouverte', detail.includes('Contenu de la commande'));
  check('historique des statuts', detail.includes('Historique des statuts'));
  check('notes internes', detail.includes('Notes internes'));
  check('totaux detailles', detail.includes('Commission'));
  await p.screenshot({ path: '/tmp/z-order-detail.png', fullPage: true });

  await p.fill('#noteText', 'Appel client effectue');
  await p.click('#addNote');
  await p.waitForTimeout(1300);
  check('note ajoutee', (await p.locator('#content').textContent()).includes('Appel client effectue'));

  await p.click('#backOrders');
  await p.waitForTimeout(1100);
  check('retour a la liste', await p.locator('#fstatus').isVisible());

  console.log('ERREURS:', errs.length ? errs.slice(0, 4) : 'aucune');
  console.log(`\n  ${pass} verifications reussies, ${fail} echecs\n`);
  await b.close();
  process.exit(fail || errs.length ? 1 : 0);
})();
