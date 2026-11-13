const { chromium } = require('playwright');
let pass = 0, fail = 0;
const check = (l, ok, extra='') => { ok ? (pass++, console.log('  ok   '+l)) : (fail++, console.log('  FAIL '+l+' '+extra)); };
const BASE = 'http://localhost:3000';
const call = async (path, { method = 'GET', body, token } = {}) => {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = {}; try { data = await res.json(); } catch {}
  return { status: res.status, data };
};

/** A brand new restaurant with one completed order, so today's cash day is open. */
async function seedFreshCashDay() {
  const stamp = String(Date.now()).slice(-7);
  const phone = `079${stamp}`;
  const name = `Caisse UI ${stamp}`;
  const admin = (await call('/auth/login', { method: 'POST', body: { identifier: 'admin@demo.ma', password: 'admin1234' } })).data.token;
  const customer = (await call('/auth/login', { method: 'POST', body: { identifier: 'client@demo.ma', password: 'client1234' } })).data.token;
  // Registration needs a verified phone: ask for a code, read it from the
  // pilot console, then sign up.
  await call('/auth/request-code', { method: 'POST', body: { phone } });
  const live = (await call('/admin/auth-codes', { token: admin })).data.codes || [];
  const code = (live.find((entry) => entry.destination === phone && entry.purpose === 'register') || {}).code;
  await call('/auth/register', { method: 'POST', body: {
    name: 'Proprio UI', phone, password: 'motdepasse1', role: 'restaurant',
    restaurant_name: name, city: 'Casablanca', code } });
  const resto = (await call('/admin/restaurants?status=pending', { token: admin })).data.restaurants.find((r) => r.name === name);
  await call(`/admin/restaurants/${resto.id}/status`, { method: 'POST', token: admin, body: { status: 'approved' } });
  const owner = (await call('/auth/login', { method: 'POST', body: { identifier: phone, password: 'motdepasse1' } })).data.token;
  const category = await call('/restaurant/categories', { method: 'POST', token: owner, body: { name: 'Plats' } });
  const product = await call('/restaurant/products', { method: 'POST', token: owner, body: {
    name: 'Plat UI', price_cents: 8000, category_id: category.data.category.id } });
  const order = await call('/orders', { method: 'POST', token: customer, body: {
    restaurant_id: resto.id, fulfillment_type: 'pickup', items: [{ product_id: product.data.product.id, quantity: 1 }] } });
  for (const s of ['accepted', 'preparing', 'ready', 'completed']) {
    await call(`/restaurant/orders/${order.data.order.id}/status`, { method: 'POST', token: owner, body: { status: s } });
  }
  return name;
}

(async () => {
  const freshResto = await seedFreshCashDay();
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1350, height: 1100 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  let reply = '';
  p.on('dialog', async (d) => { await d.accept(reply); });

  await p.goto('http://localhost:3000/admin.html', { waitUntil: 'networkidle' });
  await p.fill('#email', 'admin@demo.ma'); await p.fill('#pass', 'admin1234'); await p.click('#btn');
  await p.waitForTimeout(1500);

  await p.click('[data-section=cod]');
  await p.waitForTimeout(1500);
  const codText = await p.locator('#content').textContent();
  check('page caisse chargee', codText.includes('Journee') || codText.includes('Nous doit'));
  check('totaux caisse', (await p.locator('.stat').count()) === 5, String(await p.locator('.stat').count()));
  check('journees listees', (await p.locator('#content tbody tr').count()) >= 1);
  check('filtres caisse', await p.locator('#cResto').isVisible() && await p.locator('#cStatus').isVisible());
  await p.screenshot({ path: '/tmp/z-cod.png', fullPage: true });

  // Work on the row we just created, so the test never depends on leftovers.
  await p.selectOption('#cResto', { label: freshResto });
  await p.click('#cApply');
  await p.waitForTimeout(1400);
  check('filtre par restaurant applique', (await p.locator('#content tbody tr').count()) >= 1);
  const receiveBtn = p.locator('[data-codreceive]').first();
  if (await receiveBtn.count()) {
    reply = '12';
    await receiveBtn.click();
    await p.waitForTimeout(1500);
    check('encaissement enregistre depuis l interface',
      (await p.locator('#content').textContent()).includes('Argent re'));
    const reconcileBtn = p.locator('[data-codreconcile]').first();
    if (await reconcileBtn.count()) {
      await reconcileBtn.click();
      await p.waitForTimeout(1400);
      check('rapprochement depuis l interface', (await p.locator('#content').textContent()).includes('Rapproch'));
    } else check('rapprochement depuis l interface', false, 'bouton absent');
  } else check('encaissement enregistre depuis l interface', false, 'aucune journee ouverte');

  await p.click('[data-section=settlements]');
  await p.waitForTimeout(1500);
  check('page reglements', await p.locator('#sCreate').isVisible());
  await p.click('#sPreview');
  await p.waitForTimeout(1300);
  check('apercu calcule', (await p.locator('#previewBox').textContent()).includes('MAD'),
    await p.locator('#previewBox').textContent());
  await p.click('#sCreate');
  await p.waitForTimeout(1600);
  check('reglement cree', (await p.locator('#content tbody tr').count()) >= 1);
  const payBtn = p.locator('[data-setstatus][data-to=paid]').first();
  if (await payBtn.count()) {
    await payBtn.click();
    await p.waitForTimeout(1500);
    check('reglement marque paye', (await p.locator('#content').textContent()).includes('Pay'));
  } else check('reglement marque paye', false, 'bouton absent');
  await p.screenshot({ path: '/tmp/z-settlements.png', fullPage: true });

  console.log('ERREURS:', errs.length ? errs.slice(0, 4) : 'aucune');
  console.log(`\n  ${pass} verifications reussies, ${fail} echecs\n`);
  await b.close();
  process.exit(fail || errs.length ? 1 : 0);
})();
