const { chromium } = require('playwright');
let pass = 0, fail = 0;
const check = (l, ok, extra='') => { ok ? (pass++, console.log('  ok   '+l)) : (fail++, console.log('  FAIL '+l+' '+extra)); };
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1250, height: 1100 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  p.on('dialog', async (d) => { await d.accept('Controle hygiene'); });

  await p.goto('http://localhost:3000/admin.html', { waitUntil: 'networkidle' });
  await p.fill('#email', '0600000000');
  await p.fill('#pass', 'admin1234');
  await p.click('#btn');
  await p.waitForTimeout(1600);
  check('connexion admin par telephone', (await p.locator('#whoami').textContent()).includes('Super admin'));

  await p.click('[data-section=restaurants]');
  await p.waitForTimeout(1200);
  check('liste des restaurants', (await p.locator('[data-open]').count()) >= 2);
  await p.locator('tr', { hasText: 'Snack Atlas' }).locator('[data-open]').first().click();
  await p.waitForTimeout(1200);
  const detail = await p.locator('#content').textContent();
  check('fiche ouverte', detail.includes('Commission due') || detail.includes('Commande'));
  check('solde affiche', (await p.locator('.stat').count()) >= 6, String(await p.locator('.stat').count()));
  check('carte listee', detail.includes('Tacos') || detail.includes('Pizza'));
  check('formulaire d edition present', await p.locator('#eName').isVisible());
  check('champ commission present', await p.locator('#eComm').isVisible());
  await p.screenshot({ path: '/tmp/z-resto-detail.png', fullPage: true });

  // edit a field
  await p.fill('#ePrep', '27');
  await p.click('#saveResto');
  await p.waitForTimeout(1200);
  check('modification enregistree', (await p.locator('#ePrep').inputValue()) === '27',
    await p.locator('#ePrep').inputValue());

  // toggle availability of the first product
  const availBtn = p.locator('[data-avail]').first();
  const label = await availBtn.textContent();
  await availBtn.click();
  await p.waitForTimeout(1200);
  check('disponibilite produit basculee', (await p.locator('[data-avail]').first().textContent()) !== label,
    `${label.trim()} -> ${(await p.locator('[data-avail]').first().textContent()).trim()}`);
  await p.locator('[data-avail]').first().click();
  await p.waitForTimeout(900);

  // open/close
  const openBtn = p.locator('[data-toggleopen]').first();
  const openLabel = (await openBtn.textContent()).trim();
  await openBtn.click();
  await p.waitForTimeout(1200);
  check('ouverture/fermeture basculee', (await p.locator('[data-toggleopen]').first().textContent()).trim() !== openLabel);
  await p.locator('[data-toggleopen]').first().click();
  await p.waitForTimeout(900);

  check('retour a la liste', await p.locator('#backList').isVisible());
  await p.click('#backList');
  await p.waitForTimeout(900);
  check('liste reaffichee', (await p.locator('[data-open]').count()) >= 2);

  console.log('ERREURS:', errs.length ? errs.slice(0, 4) : 'aucune');
  console.log(`\n  ${pass} verifications reussies, ${fail} echecs\n`);
  await b.close();
  process.exit(fail || errs.length ? 1 : 0);
})();
