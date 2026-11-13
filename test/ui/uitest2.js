const { chromium } = require('playwright');
const { dismissAddressGate } = require('./_shared.js');
let pass = 0, fail = 0;
const check = (l, ok, extra='') => { ok ? (pass++, console.log('  ok   '+l)) : (fail++, console.log('  FAIL '+l+' '+extra)); };

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  page.on('pageerror', (e) => errors.push('customer: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('customer console: ' + m.text()); });

  console.log('\n== Client (francais) ==');
  await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
  await dismissAddressGate(page);
  await page.waitForTimeout(500);
  check('page chargee', (await page.locator('[data-resto]').count()) >= 2, String(await page.locator('[data-resto]').count()));

  await page.click('#navAccount');
  await page.fill('#liId', 'client@demo.ma');
  await page.fill('#liPass', 'client1234');
  await page.click('#liBtn');
  await page.waitForTimeout(800);
  check('connexion client', (await page.locator('.toast').first().textContent()).includes('Bienvenue'));

  await page.locator('[data-resto]').filter({ hasText: 'Snack Atlas' }).click();
  await page.waitForTimeout(600);
  check('menu affiche', (await page.locator('[data-add]').count()) >= 5, String(await page.locator('[data-add]').count()));
  check('mention "a partir de" sur les plats a options', (await page.locator('text=partir de').count()) >= 1);

  // --- options modal ---
  await page.locator('.item', { hasText: 'Tacos poulet' }).locator('[data-add]').first().click();
  await page.waitForTimeout(400);
  check('fenetre d options ouverte', await page.locator('.modal').isVisible());
  const groupCount = await page.locator('.optgroup').count();
  check('3 groupes d options', groupCount === 3, String(groupCount));
  check('taille obligatoire preselectionnee', await page.locator('input[type=radio]').first().isChecked());
  const priceBefore = await page.locator('#optTotal').textContent();
  await page.locator('.optgroup').nth(0).locator('input[type=radio]').nth(2).check(); // XXL +20
  await page.waitForTimeout(150);
  const priceAfterSize = await page.locator('#optTotal').textContent();
  check(`prix met a jour avec la taille (${priceBefore.trim()} -> ${priceAfterSize.trim()})`, priceBefore !== priceAfterSize);
  await page.locator('.optgroup').nth(2).locator('input[type=checkbox]').first().check(); // fromage +5
  await page.waitForTimeout(150);
  check('prix met a jour avec le supplement', (await page.locator('#optTotal').textContent()).includes('60.00'), await page.locator('#optTotal').textContent());

  // max 3 sauces enforced in UI
  const sauces = page.locator('.optgroup').nth(1).locator('input[type=checkbox]');
  for (let i = 0; i < 4; i++) { await sauces.nth(i).click(); await page.waitForTimeout(80); }
  await page.waitForTimeout(200);
  const checkedSauces = await page.locator('.optgroup').nth(1).locator('input:checked').count();
  check('maximum de 3 sauces respecte dans l interface', checkedSauces === 3, String(checkedSauces));

  await page.fill('#itemNote', 'bien epice');
  await page.click('#confirmOpt');
  await page.waitForTimeout(500);
  check('ajout au panier', (await page.locator('#cartCount').textContent()).includes('1'));

  await page.click('#goToCart');
  await page.waitForTimeout(500);
  check('options listees dans le panier', (await page.locator('#viewCart').textContent()).includes('XXL'));
  check('note du plat visible', (await page.locator('#viewCart').textContent()).includes('bien epice'));
  check('total du panier correct', (await page.locator('#ckTotal').textContent()).includes('60.00'), await page.locator('#ckTotal').textContent());
  await page.screenshot({ path: '/tmp/n-cart-fr.png', fullPage: true });

  await page.click('#placeOrder');
  await page.waitForTimeout(1200);
  check('commande envoyee', (await page.locator('.toast').first().textContent()).includes('envoyée'));
  check('commande listee', (await page.locator('#viewOrders .card').count()) >= 1);
  await page.screenshot({ path: '/tmp/n-orders-fr.png', fullPage: true });

  console.log('\n== Client (arabe / RTL) ==');
  await page.click('#langBtn');
  await page.waitForTimeout(900);
  check('direction RTL activee', (await page.getAttribute('html', 'dir')) === 'rtl');
  check('langue html = ar', (await page.getAttribute('html', 'lang')) === 'ar');
  const arText = await page.locator('main').textContent();
  check('interface traduite en arabe', arText.includes('طلباتي') || arText.includes('مرحبا'), arText.slice(0, 60));
  await page.screenshot({ path: '/tmp/n-orders-ar.png', fullPage: true });

  await page.click('#homeLink');
  await page.waitForTimeout(700);
  check('noms des restaurants en arabe', (await page.locator('#restoList').textContent()).includes('سناك أطلس'));
  await page.screenshot({ path: '/tmp/n-home-ar.png' });

  await page.locator('[data-resto]').filter({ hasText: 'سناك أطلس' }).first().click();
  await page.waitForTimeout(600);
  await page.locator('.item', { hasText: 'طاكوس دجاج' }).locator('[data-add]').first().click();
  await page.waitForTimeout(400);
  const modalAr = await page.locator('.modal').textContent();
  check('options traduites en arabe', modalAr.includes('الحجم') || modalAr.includes('متوسط'), modalAr.slice(0, 50));
  await page.screenshot({ path: '/tmp/n-options-ar.png' });
  await page.click('#cancelOpt');

  console.log('\n== Restaurant ==');
  const page2 = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  page2.on('pageerror', (e) => errors.push('resto: ' + e.message));
  page2.on('console', (m) => { if (m.type() === 'error') errors.push('resto console: ' + m.text()); });
  await page2.goto('http://localhost:3000/restaurant.html', { waitUntil: 'networkidle' });
  await page2.fill('#liId', 'resto1@demo.ma');
  await page2.fill('#liPass', 'resto1234');
  await page2.click('#liBtn');
  await page2.waitForTimeout(1200);
  check('tableau de bord charge', (await page2.locator('h1').textContent()).includes('Snack Atlas'));
  const boardText = await page2.locator('#tabBody').textContent();
  check('commande visible', boardText.includes('CMD-'));
  check('options affichees pour la cuisine', boardText.includes('XXL') && boardText.includes('Fromage'), boardText.slice(0, 200));
  check('note du plat transmise', boardText.includes('bien epice'));
  check('case son presente', await page2.locator('#soundToggle').isVisible());
  await page2.screenshot({ path: '/tmp/n-resto-orders.png', fullPage: true });

  await page2.locator('[data-status=accepted]').first().click();
  await page2.waitForTimeout(900);
  check('commande acceptee', (await page2.locator('#tabBody').textContent()).includes('En pr'));

  await page2.click('[data-tab=menu]');
  await page2.waitForTimeout(900);
  const menuText = await page2.locator('#tabBody').textContent();
  check('editeur de menu charge', menuText.includes('Tacos poulet'));
  check('groupes d options visibles dans l editeur', menuText.includes('Taille') && menuText.includes('Supplements'));
  check('bouton ajout de groupe', (await page2.locator('[data-addgroup]').count()) >= 5);
  check('champs arabes presents', (await page2.locator('#pNameAr').count()) === 1);
  await page2.screenshot({ path: '/tmp/n-resto-menu.png', fullPage: true });

  await page2.click('[data-tab=stats]');
  await page2.waitForTimeout(800);
  check('page chiffres', (await page2.locator('.stat').count()) >= 6);

  await page2.click('[data-tab=settings]');
  await page2.waitForTimeout(600);
  check('reglages avec champs arabes', await page2.locator('#sNameAr').isVisible());

  console.log('\n== Admin ==');
  const page3 = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  page3.on('pageerror', (e) => errors.push('admin: ' + e.message));
  page3.on('console', (m) => { if (m.type() === 'error') errors.push('admin console: ' + m.text()); });
  page3.on('dialog', async (d) => {
    if (d.type() === 'prompt') await d.accept(d.message().includes('Raison') ? 'Plat manquant' : '10');
    else await d.accept();
  });
  await page3.goto('http://localhost:3000/admin.html', { waitUntil: 'networkidle' });
  await page3.fill('#email', 'admin@demo.ma');
  await page3.fill('#pass', 'admin1234');
  await page3.click('#btn');
  await page3.waitForTimeout(1200);
  check('tableau de bord admin', (await page3.locator('.stat').count()) >= 8, String(await page3.locator('.stat').count()));
  await page3.screenshot({ path: '/tmp/n-admin.png', fullPage: true });

  // complete the order first so it can be refunded
  for (const s of ['preparing', 'ready', 'completed']) {
    await page2.click('[data-tab=orders]');
    await page2.waitForTimeout(700);
    const btn = page2.locator(`[data-status=${s}]`).first();
    if (await btn.count()) { await btn.click(); await page2.waitForTimeout(800); }
  }
  await page3.click('[data-section=orders]');
  await page3.waitForTimeout(900);
  check('onglet commandes admin', (await page3.locator('#content').textContent()).includes('CMD-'));
  // The refund now lives inside the order detail page.
  await page3.selectOption('#fstatus', 'completed');
  await page3.click('#applyFilters');
  await page3.waitForTimeout(1300);
  await page3.locator('[data-order]').first().click();
  await page3.waitForTimeout(1400);
  const refundBtn = page3.locator('[data-dorefund]').first();
  check('bouton remboursement sur commande terminee', (await refundBtn.count()) > 0);
  if (await refundBtn.count()) {
    await refundBtn.click();
    await page3.waitForTimeout(1500);
    check('remboursement applique', (await page3.locator('#content').textContent()).includes('Remboursements'));
  }
  await page3.click('#backOrders');
  await page3.waitForTimeout(1000);
  await page3.screenshot({ path: '/tmp/n-admin-orders.png', fullPage: true });

  await page3.click('[data-section=audit]');
  await page3.waitForTimeout(900);
  const auditText = await page3.locator('#content').textContent();
  check('journal d audit rempli', auditText.includes('refund') || auditText.includes('cash_collected'), auditText.slice(0, 120));
  await page3.screenshot({ path: '/tmp/n-admin-audit.png', fullPage: true });

  await page3.click('#langBtn');
  await page3.waitForTimeout(900);
  check('admin en arabe', (await page3.getAttribute('html', 'dir')) === 'rtl');
  await page3.screenshot({ path: '/tmp/n-admin-ar.png', fullPage: true });

  console.log('\nERREURS CONSOLE: ' + (errors.length ? JSON.stringify(errors.slice(0, 8), null, 1) : 'aucune'));
  console.log(`\n  ${pass} verifications reussies, ${fail} echecs\n`);
  await browser.close();
  process.exit(fail || errors.length ? 1 : 0);
})();
