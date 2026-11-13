const { chromium } = require('playwright');
let pass = 0, fail = 0;
const check = (l, ok, extra='') => { ok ? (pass++, console.log('  ok   '+l)) : (fail++, console.log('  FAIL '+l+' '+extra)); };

const BASE = 'http://localhost:3000';
const call = async (path, { method = 'GET', body, token } = {}) => {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}/api${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = {}; try { data = await res.json(); } catch {}
  return { status: res.status, data };
};

/**
 * The demo restaurant needs at least one completed order today, otherwise it
 * has no cash day to declare and this screen is legitimately empty.
 */
async function ensureCashDay() {
  const admin = (await call('/auth/login', { method: 'POST', body: {
    identifier: '0600000000', password: 'admin1234' } })).data.token;
  const owner = (await call('/auth/login', { method: 'POST', body: {
    identifier: 'resto1@demo.ma', password: 'resto1234' } })).data.token;
  const customer = (await call('/auth/login', { method: 'POST', body: {
    identifier: 'client@demo.ma', password: 'client1234' } })).data.token;
  if (!admin || !owner || !customer) return;

  const mine = (await call('/restaurant/me', { token: owner })).data.restaurant;
  const open = (await call('/admin/cod?restaurant_id=' + mine.id, { token: admin })).data.days || [];
  if (open.some((day) => day.status === 'open' || day.status === 'declared')) return;

  const menu = (await call(`/restaurants/${mine.id}`)).data;
  const dish = menu.menu.flatMap((c) => c.products)
    .find((product) => !(product.option_groups || []).some((group) => group.min_select > 0));
  if (!dish) return;

  const order = await call('/orders', { method: 'POST', token: customer, body: {
    restaurant_id: mine.id, fulfillment_type: 'pickup',
    items: [{ product_id: dish.id, quantity: 1 }] } });
  if (!order.data.order) return;
  for (const status of ['accepted', 'preparing', 'ready', 'completed']) {
    await call(`/restaurant/orders/${order.data.order.id}/status`, {
      method: 'POST', token: owner, body: { status } });
  }
}

(async () => {
  await ensureCashDay();
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1100, height: 1000 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  p.on('dialog', async (d) => { await d.accept('5'); });

  await p.goto('http://localhost:3000/restaurant.html', { waitUntil: 'networkidle' });
  await p.fill('#liId', 'resto1@demo.ma'); await p.fill('#liPass', 'resto1234'); await p.click('#liBtn');
  await p.waitForTimeout(1500);
  await p.click('[data-tab=stats]');
  await p.waitForTimeout(1600);
  const text = await p.locator('#tabBody').textContent();
  check('section caisse presente', text.includes('Ma caisse'));
  check('total a reverser affiche', text.includes('Total a reverser'));
  const rows = await p.locator('#codBox tbody tr').count();
  check('journees listees pour le restaurant', rows >= 1, String(rows));
  const declareBtn = p.locator('[data-declare]').first();
  if (await declareBtn.count()) {
    await declareBtn.click();
    await p.waitForTimeout(1500);
    check('declaration enregistree', (await p.locator('#codBox').textContent()).includes('Declaree') ||
      (await p.locator('.toast').first().textContent().catch(() => '')).includes('Declaration'));
  } else {
    // Every day is already reconciled: the button is correctly hidden.
    check('journees deja rapprochees: bouton masque',
      (await p.locator('#codBox').textContent()).includes('Rapproch'),
      await p.locator('#codBox').textContent());
  }
  await p.screenshot({ path: '/tmp/z-cashbox.png', fullPage: true });
  console.log('ERREURS:', errs.length ? errs.slice(0, 4) : 'aucune');
  console.log(`\n  ${pass} verifications reussies, ${fail} echecs\n`);
  await b.close();
  process.exit(fail || errs.length ? 1 : 0);
})();
