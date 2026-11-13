const { chromium } = require('playwright');
const { dismissAddressGate } = require('./_shared.js');
let pass = 0, fail = 0;
const check = (l, ok, extra='') => { ok ? (pass++, console.log('  ok   '+l)) : (fail++, console.log('  FAIL '+l+' '+extra)); };
const stamp = Date.now();
const phone = `064${String(stamp).slice(-7)}`;

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  page.on('pageerror', (e) => errors.push('client: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('client console: ' + m.text()); });

  console.log('\n== Inscription par telephone ==');
  await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
  await dismissAddressGate(page);
  await page.waitForTimeout(500);
  await page.click('#navAccount');
  await page.click('#tabRegister');
  await page.waitForTimeout(300);
  check('formulaire demande le telephone en premier', await page.locator('#rgPhone').isVisible());
  check('email marque optionnel', (await page.locator('#viewAccount').textContent()).includes('optionnel'));
  await page.fill('#rgName', 'Client Test');
  await page.fill('#rgPhone', phone);
  await page.fill('#rgPass', 'motdepasse1');
  await page.click('#rgBtn');
  await page.waitForTimeout(1200);

  // Step two: the phone code. Read it from the admin console, as an operator would.
  check('etape du code affichee', await page.locator('#rgCode').isVisible());
  const adminToken = (await (await fetch('http://localhost:3000/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: '0600000000', password: 'admin1234' }) })).json()).token;
  const live = await (await fetch('http://localhost:3000/api/admin/auth-codes', {
    headers: { Authorization: `Bearer ${adminToken}` } })).json();
  const entry = (live.codes || []).find((c) => c.destination === phone && c.purpose === 'register');
  check('code visible dans la console admin', !!entry);
  await page.fill('#rgCode', entry.code);
  await page.click('#rgConfirm');
  await page.waitForTimeout(1200);
  check('inscription sans email reussie', (await page.locator('.toast').first().textContent()).includes('Bienvenue'));

  console.log('\n== Mon compte ==');
  await page.click('#navAccount');
  await page.waitForTimeout(500);
  check('mes informations affichees', await page.locator('#acName').isVisible());
  check('numero pre-rempli', (await page.locator('#acPhone').inputValue()) === phone, await page.locator('#acPhone').inputValue());
  await page.fill('#acName', 'Nom Change');
  await page.fill('#acEmail', `ui${stamp}@test.ma`);
  await page.click('#acSave');
  await page.waitForTimeout(800);
  check('modification enregistree', (await page.locator('.toast').first().textContent()).includes('enregistr'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.click('#navAccount');
  await page.waitForTimeout(700);
  check('modification persistee', (await page.locator('#acName').inputValue()) === 'Nom Change');
  await page.screenshot({ path: '/tmp/x-account.png', fullPage: true });

  console.log('\n== Aide et FAQ ==');
  await page.click('#navHelp');
  await page.waitForTimeout(600);
  const faqCount = await page.locator('[data-faq]').count();
  check('FAQ affichee', faqCount >= 8, String(faqCount));
  await page.locator('[data-faq]').first().click();
  await page.waitForTimeout(200);
  check('reponse FAQ se deplie', await page.locator('#faq0').isVisible());
  await page.fill('#spSubject', 'Test depuis le navigateur');
  await page.fill('#spMessage', 'Ceci est un message de test envoye par le navigateur.');
  await page.click('#spSend');
  await page.waitForTimeout(900);
  check('message au support envoye', (await page.locator('.toast').first().textContent()).includes('envoy'));
  await page.screenshot({ path: '/tmp/x-help.png', fullPage: true });

  console.log('\n== Pages legales ==');
  for (const [key, needle] of [['terms', 'Conditions'], ['privacy', 'confidentialité'], ['about', 'propos']]) {
    await page.locator(`#viewHelp [data-legal=${key}]`).click();
    await page.waitForTimeout(700);
    const text = await page.locator('#viewLegal').textContent();
    check(`page ${key} affichee`, text.includes(needle), text.slice(0, 60));
    // The business details are empty in this environment, so the page must warn.
    check(`page ${key} avertit que les mentions sont incompletes`,
      text.includes('incomplètes') || text.includes('juriste'), text.slice(0, 90));
    if (key === 'privacy') check('politique cite la loi 09-08', text.includes('09-08'));
    await page.click('#legalBack');
    await page.waitForTimeout(400);
  }
  await page.locator('#viewHelp [data-legal=privacy]').click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/x-privacy.png', fullPage: true });
  await page.click('#legalBack');

  console.log('\n== Code promo dans le panier ==');
  await page.click('#homeLink');
  await page.waitForTimeout(700);
  await page.locator('[data-resto]').filter({ hasText: 'Snack Atlas' }).click();
  await page.waitForTimeout(600);
  await page.locator('.item', { hasText: 'Tacos poulet' }).locator('[data-add]').first().click();
  await page.waitForTimeout(400);
  await page.click('#confirmOpt');
  await page.waitForTimeout(400);
  await page.locator('.item', { hasText: 'Tacos poulet' }).locator('[data-add]').first().click();
  await page.waitForTimeout(400);
  await page.click('#confirmOpt');
  await page.waitForTimeout(400);
  await page.click('#goToCart');
  await page.waitForTimeout(900);
  const totalBefore = await page.locator('#ckTotal').textContent();
  check('champ code promo present', await page.locator('#ckPromo').isVisible());
  await page.fill('#ckPromo', 'bienvenue10');
  await page.click('#ckPromoBtn');
  await page.waitForTimeout(1100);
  check('code applique', (await page.locator('.toast').first().textContent()).includes('appliqu'),
    await page.locator('.toast').first().textContent().catch(() => ''));
  check('ligne de reduction affichee', await page.locator('#ckDiscountRow').isVisible());
  const totalAfter = await page.locator('#ckTotal').textContent();
  check(`total baisse (${totalBefore.trim()} -> ${totalAfter.trim()})`, totalBefore !== totalAfter);
  check('reduction de 7.00 MAD', (await page.locator('#ckDiscount').textContent()).includes('7.00'),
    await page.locator('#ckDiscount').textContent());
  await page.screenshot({ path: '/tmp/x-cart-promo.png', fullPage: true });

  await page.click('#placeOrder');
  await page.waitForTimeout(1400);
  check('commande passee avec reduction', (await page.locator('.toast').first().textContent()).includes('envoy'));

  console.log('\n== Arabe ==');
  await page.click('#navHelp');
  await page.waitForTimeout(600);
  await page.click('#langBtn');
  await page.waitForTimeout(900);
  const helpAr = await page.locator('#viewHelp').textContent();
  check('aide traduite en arabe', helpAr.includes('أسئلة متكررة'), helpAr.slice(0, 50));
  check('direction RTL', (await page.getAttribute('html', 'dir')) === 'rtl');
  await page.locator('#viewHelp [data-legal=privacy]').click();
  await page.waitForTimeout(600);
  const privAr = await page.locator('#viewLegal').textContent();
  check('politique de confidentialite en arabe', privAr.includes('سياسة الخصوصية'), privAr.slice(0, 40));
  await page.screenshot({ path: '/tmp/x-privacy-ar.png', fullPage: true });

  console.log('\n== Admin: codes promo et messages ==');
  const page2 = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  page2.on('pageerror', (e) => errors.push('admin: ' + e.message));
  page2.on('console', (m) => { if (m.type() === 'error') errors.push('admin console: ' + m.text()); });
  page2.on('dialog', async (d) => { await d.accept(); });
  await page2.goto('http://localhost:3000/admin.html', { waitUntil: 'networkidle' });
  await page2.fill('#email', 'admin@demo.ma');
  await page2.fill('#pass', 'admin1234');
  await page2.click('#btn');
  await page2.waitForTimeout(1200);
  check('tuiles du tableau de bord', (await page2.locator('.stat').count()) >= 5, String(await page2.locator('.stat').count()));

  await page2.click('[data-section=promos]');
  await page2.waitForTimeout(900);
  check('onglet codes promo', (await page2.locator('#content').textContent()).includes('BIENVENUE10'));
  const newCode = `UITEST${String(stamp).slice(-5)}`;
  await page2.fill('#pcCode', newCode);
  await page2.selectOption('#pcType', 'fixed');
  await page2.waitForTimeout(200);
  await page2.fill('#pcValue', '15');
  await page2.selectOption('#pcFunded', 'restaurant');
  await page2.click('#pcCreate');
  await page2.waitForTimeout(1200);
  check('code cree depuis l interface', (await page2.locator('#content').textContent()).includes(newCode));
  check('qui paie affiche', (await page2.locator('#content').textContent()).includes('restaurant') ||
    (await page2.locator('#content').textContent()).includes('Le restaurant'));
  await page2.screenshot({ path: '/tmp/x-admin-promos.png', fullPage: true });

  await page2.click('[data-section=messages]');
  await page2.waitForTimeout(900);
  const supportText = await page2.locator('#content').textContent();
  check('message recu dans l admin', supportText.includes('Test depuis le navigateur'), supportText.slice(0, 80));
  check('numero du client visible', supportText.includes(phone));
  check('lien WhatsApp present', (await page2.locator('a[href*="wa.me"]').count()) >= 1);
  await page2.locator('[data-handled]').first().click();
  await page2.waitForTimeout(1000);
  check('message marque traite', (await page2.locator('#content').textContent()).includes('Traité'));
  await page2.screenshot({ path: '/tmp/x-admin-support.png', fullPage: true });

  console.log('\nERREURS CONSOLE: ' + (errors.length ? JSON.stringify(errors.slice(0, 6), null, 1) : 'aucune'));
  console.log(`\n  ${pass} verifications reussies, ${fail} echecs\n`);
  await browser.close();
  process.exit(fail || errors.length ? 1 : 0);
})();
