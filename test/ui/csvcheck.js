const { chromium } = require('playwright');
let pass = 0, fail = 0;
const check = (l, ok, extra='') => { ok ? (pass++, console.log('  ok   '+l)) : (fail++, console.log('  FAIL '+l+' '+extra)); };
const fs = require('fs');

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
 * Proving that an export honours a filter needs both kinds of row: at least
 * one completed order and at least one that is not. On a brand new database
 * neither exists, so they are created here.
 */
async function ensureMixedOrders() {
  const owner = (await call('/auth/login', { method: 'POST', body: {
    identifier: 'resto1@demo.ma', password: 'resto1234' } })).data.token;
  const customer = (await call('/auth/login', { method: 'POST', body: {
    identifier: 'client@demo.ma', password: 'client1234' } })).data.token;
  if (!owner || !customer) return;

  const mine = (await call('/restaurant/me', { token: owner })).data.restaurant;
  const menu = (await call(`/restaurants/${mine.id}`)).data;
  const dish = menu.menu.flatMap((c) => c.products)
    .find((product) => !(product.option_groups || []).some((group) => group.min_select > 0));
  if (!dish) return;

  const place = async () => (await call('/orders', { method: 'POST', token: customer, body: {
    restaurant_id: mine.id, fulfillment_type: 'pickup',
    items: [{ product_id: dish.id, quantity: 1 }] } })).data.order;

  // one carried through to completed
  const done = await place();
  if (done) {
    for (const status of ['accepted', 'preparing', 'ready', 'completed']) {
      await call(`/restaurant/orders/${done.id}/status`, {
        method: 'POST', token: owner, body: { status } });
    }
  }
  // one left pending, so a status filter has something to exclude
  await place();
}

(async () => {
  await ensureMixedOrders();
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1350, height: 1000 }, acceptDownloads: true });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

  await p.goto('http://localhost:3000/admin.html', { waitUntil: 'networkidle' });
  await p.fill('#email', 'admin@demo.ma'); await p.fill('#pass', 'admin1234'); await p.click('#btn');
  await p.waitForTimeout(1600);

  const grab = async (section, buttonId) => {
    await p.click(`[data-section=${section}]`);
    await p.waitForTimeout(1300);
    const [dl] = await Promise.all([
      p.waitForEvent('download', { timeout: 15000 }),
      p.locator(`#${buttonId}`).click(),
    ]);
    return fs.readFileSync(await dl.path(), 'utf8');
  };

  const orders = await grab('orders', 'ordersCsv');
  const allRows = orders.trim().split('\n').length - 1;
  check('export commandes', orders.includes('order_number') && allRows >= 1, `${allRows} lignes`);

  // same screen, with a filter applied
  await p.selectOption('#fstatus', 'completed');
  await p.click('#applyFilters');
  await p.waitForTimeout(1400);
  const [dl2] = await Promise.all([
    p.waitForEvent('download', { timeout: 15000 }),
    p.locator('#ordersCsv').click(),
  ]);
  const filtered = fs.readFileSync(await dl2.path(), 'utf8');
  const filteredRows = filtered.trim().split('\n').length - 1;
  check(`export respecte le filtre statut (${allRows} -> ${filteredRows})`, filteredRows < allRows && filteredRows >= 1);
  check('toutes les lignes exportees sont terminees',
    filtered.trim().split('\n').slice(1).every((l) => l.includes('completed')), filtered.slice(0, 120));

  check('export comptes', (await grab('customers', 'usersCsv')).includes('phone'));
  check('export caisse', (await grab('cod', 'codCsv')).includes('expected_cents'));
  check('export reglements', (await grab('settlements', 'setCsv')).includes('net_payable_cents'));
  const audit = await grab('audit', 'auditCsv');
  check('export journal', audit.includes('action') && audit.includes('before_state'));

  console.log('ERREURS:', errs.length ? errs.slice(0, 4) : 'aucune');
  console.log(`\n  ${pass} verifications reussies, ${fail} echecs\n`);
  await b.close();
  process.exit(fail || errs.length ? 1 : 0);
})();
