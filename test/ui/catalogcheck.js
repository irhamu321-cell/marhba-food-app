const { chromium } = require('playwright');
let pass = 0, fail = 0;
const check = (l, ok, extra='') => { ok ? (pass++, console.log('  ok   '+l)) : (fail++, console.log('  FAIL '+l+' '+extra)); };
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1250, height: 1200 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  let answers = ['Taille', '1', '1'];
  let i = 0;
  p.on('dialog', async (d) => { await d.accept(answers[i++] ?? ''); });

  await p.goto('http://localhost:3000/admin.html', { waitUntil: 'networkidle' });
  await p.fill('#email', 'admin@demo.ma'); await p.fill('#pass', 'admin1234'); await p.click('#btn');
  await p.waitForTimeout(1500);
  await p.click('[data-section=catalog]');
  await p.waitForTimeout(1500);

  check('page catalogue', await p.locator('#catResto').isVisible());
  await p.selectOption('#catResto', { label: 'Snack Atlas' });
  await p.waitForTimeout(1400);
  check('compteurs catalogue', (await p.locator('.stat').count()) === 3);
  const text = await p.locator('#content').textContent();
  check('produits listes', text.includes('Tacos') || text.includes('Pizza'));
  check('groupes d options affiches', text.includes('Taille'));
  check('meilleures ventes', text.includes('Meilleures ventes'));
  check('formulaire d ajout', await p.locator('#npName').isVisible());
  await p.screenshot({ path: '/tmp/z-catalog.png', fullPage: true });

  const unique = String(Date.now()).slice(-5);
  await p.fill('#npName', `Produit UI ${unique}`);
  await p.fill('#npPrice', '33');
  await p.click('#npAdd');
  await p.waitForTimeout(1500);
  check('produit ajoute depuis le catalogue', (await p.locator('#content').textContent()).includes(`Produit UI ${unique}`));

  await p.fill('#ncName', `Cat UI ${unique}`);
  await p.click('#ncAdd');
  await p.waitForTimeout(1500);
  check('categorie ajoutee', (await p.locator('#content').textContent()).includes(`Cat UI ${unique}`));

  const other = await p.locator('#catResto option').nth(1).getAttribute('value');
  await p.selectOption('#catResto', other);
  await p.waitForTimeout(1400);
  check('changement de restaurant', (await p.locator('#catResto').inputValue()) === other);

  console.log('ERREURS:', errs.length ? errs.slice(0, 4) : 'aucune');
  console.log(`\n  ${pass} verifications reussies, ${fail} echecs\n`);
  await b.close();
  process.exit(fail || errs.length ? 1 : 0);
})();
