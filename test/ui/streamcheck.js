/*
 * The live order stream, the kitchen bell, and the audio unlock prompt.
 *
 * The bell is checked by instrumenting the Web Audio API in the page rather
 * than by listening: a headless browser makes no noise, but it does create
 * oscillators, and counting those proves the bell rang and kept ringing. The
 * autoplay prompt matters as much as the sound — a bell the owner believes is
 * on and which is muted is worse than no bell.
 */
const { chromium } = require('playwright');
const { apiLogin } = require('./_shared.js');

let pass = 0, fail = 0;
const check = (l, ok, extra = '') => {
  ok ? (pass++, console.log('  ok   ' + l)) : (fail++, console.log('  FAIL ' + l + ' ' + extra));
};

const BASE = 'http://localhost:3000';
const api = async (path, { method = 'GET', token, body } = {}) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

/** Counts every tone the page tries to play. */
const COUNT_AUDIO = () => {
  window.__audio = { oscillators: 0, resumed: 0, state: 'suspended' };
  const Real = window.AudioContext || window.webkitAudioContext;
  class Counting {
    constructor() {
      this.currentTime = 0;
      this.state = window.__audio.state;
      this.destination = {};
    }
    createOscillator() {
      window.__audio.oscillators += 1;
      return {
        connect() {}, start() {}, stop() {},
        type: '', frequency: { value: 0 },
      };
    }
    createGain() {
      return {
        connect() {},
        gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      };
    }
    async resume() {
      window.__audio.resumed += 1;
      window.__audio.state = 'running';
      this.state = 'running';
    }
    async close() {}
  }
  window.AudioContext = Counting;
  window.webkitAudioContext = Counting;
  window.__RealAudioContext = Real;
};

(async () => {
const b = await chromium.launch();
const errs = [];
const watch = (p) => {
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  p.on('dialog', async (d) => { await d.accept(); });
};

const rToken = await apiLogin('resto1@demo.ma', 'resto1234');
const cToken = await apiLogin('0633333333', 'client1234');

/* A dish with no compulsory choices, so an order is one line of JSON. */
const menu = (await api('/restaurants/1')).data;
const products = [
  ...(menu.menu || []).flatMap((c) => c.products || []),
  ...(menu.uncategorized || []),
].filter((x) => x.is_available !== false);
const dish = products.find((x) => !(x.option_groups || []).some((g) => g.is_required)) || products[0];

const placeOrder = (extra = {}) => api('/orders', {
  method: 'POST', token: cToken,
  body: {
    restaurant_id: 1, fulfillment_type: 'pickup',
    items: [{ product_id: dish.id, quantity: 1 }],
    ...extra,
  },
});

/* ---------------------------------------------------------------- */
console.log('\n== Le ticket de flux ==');
const ticket = await api('/restaurant/stream-ticket', { method: 'POST', token: rToken });
check('un restaurant obtient un ticket', ticket.status === 201 && !!ticket.data.ticket,
  JSON.stringify(ticket.data).slice(0, 90));
check('le ticket est court', Number(ticket.data.expires_in_seconds) <= 60,
  String(ticket.data.expires_in_seconds));
check('un client n obtient pas de ticket',
  (await api('/restaurant/stream-ticket', { method: 'POST', token: cToken })).status === 403);
check('sans jeton, pas de ticket',
  (await api('/restaurant/stream-ticket', { method: 'POST' })).status === 401);

const streamRes = await fetch(`${BASE}/api/restaurant/stream?ticket=${ticket.data.ticket}`);
check('le flux repond en text/event-stream',
  String(streamRes.headers.get('content-type')).includes('text/event-stream'),
  String(streamRes.headers.get('content-type')));
check('le flux demande a ne pas etre mis en tampon',
  streamRes.headers.get('x-accel-buffering') === 'no');
streamRes.body.cancel();

check('un ticket ne sert qu une fois',
  (await fetch(`${BASE}/api/restaurant/stream?ticket=${ticket.data.ticket}`)).status === 401);
check('un ticket invente est refuse',
  (await fetch(`${BASE}/api/restaurant/stream?ticket=nimportequoi`)).status === 401);
check('sans ticket, refus',
  (await fetch(`${BASE}/api/restaurant/stream`)).status === 401);

/* ---------------------------------------------------------------- */
console.log('\n== Le tableau de bord en direct ==');
const p = await b.newPage({ viewport: { width: 1280, height: 1000 } });
watch(p);
await p.addInitScript(COUNT_AUDIO);
await p.goto(`${BASE}/restaurant.html`, { waitUntil: 'networkidle' });
await p.fill('#liId', 'resto1@demo.ma');
await p.fill('#liPass', 'resto1234');
await p.click('#liBtn');
await p.waitForTimeout(2600);

check('l indicateur de flux est affiche', await p.locator('#streamBadge').isVisible());
await p.waitForFunction(
  () => document.getElementById('streamBadge')?.classList.contains('green'),
  null, { timeout: 10000 },
).catch(() => {});
check('le flux passe en direct',
  (await p.locator('#streamBadge').getAttribute('class')).includes('green'),
  await p.locator('#streamBadge').innerText());

/* ---------------------------------------------------------------- */
console.log('\n== L invitation a activer le son ==');
check('le bandeau demande d activer le son', await p.locator('#audioPrompt').isVisible());
check('le bandeau explique pourquoi',
  /navigateur/i.test(await p.locator('#audioPrompt').innerText()),
  await p.locator('#audioPrompt').innerText());
check('aucun son n a encore ete tente',
  (await p.evaluate(() => window.__audio.oscillators)) === 0,
  String(await p.evaluate(() => window.__audio.oscillators)));

await p.click('#enableSound');
await p.waitForTimeout(1200);
check('le contexte audio est relance par le clic',
  (await p.evaluate(() => window.__audio.resumed)) >= 1);
check('un son de test est joue',
  (await p.evaluate(() => window.__audio.oscillators)) >= 1,
  String(await p.evaluate(() => window.__audio.oscillators)));
check('le bandeau disparait une fois le son actif',
  await p.locator('#audioPrompt').count() === 0);

/* ---------------------------------------------------------------- */
console.log('\n== La cloche insiste ==');

/*
 * Every order still waiting is accepted first.
 *
 * The bell is tied to the state of the board, not to one event, so with
 * orders left over from another suite it would be ringing correctly before
 * this section even starts — and "it stopped" could not be measured.
 */
{
  const waiting = (await api('/restaurant/orders?status=active', { token: rToken }))
    .data.orders.filter((o) => o.status === 'pending');
  for (const order of waiting) {
    await api(`/restaurant/orders/${order.id}/status`,
      { method: 'POST', token: rToken, body: { status: 'accepted', note: '' } });
  }
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(2600);
  if (await p.locator('#enableSound').count()) {
    await p.click('#enableSound');
    await p.waitForTimeout(800);
  }
  check('le tableau de bord n a plus de commande en attente',
    await p.locator('[data-status="accepted"]').count() === 0,
    String(await p.locator('[data-status="accepted"]').count()));
}

await p.evaluate(() => { window.__audio.oscillators = 0; });
const pushed = await placeOrder();
check('la commande de test est passee', pushed.status === 201,
  JSON.stringify(pushed.data).slice(0, 100));
const orderNumber = pushed.data.order.order_number;

await p.waitForFunction(
  (n) => document.body.innerText.includes(n), orderNumber, { timeout: 12000 },
).catch(() => {});
check('la commande apparait sans attendre le rafraichissement',
  (await p.locator('body').innerText()).includes(orderNumber), orderNumber);

await p.waitForFunction(() => window.__audio.oscillators >= 1, null, { timeout: 8000 })
  .catch(() => {});
const firstRing = await p.evaluate(() => window.__audio.oscillators);
check('la cloche sonne a l arrivee', firstRing >= 1, String(firstRing));

// It has to keep ringing: one chime in a kitchen is one chime nobody heard.
await p.waitForTimeout(5000);
const secondRing = await p.evaluate(() => window.__audio.oscillators);
check('la cloche continue de sonner', secondRing > firstRing,
  `${firstRing} -> ${secondRing}`);

/* ---------------------------------------------------------------- */
console.log('\n== Accepter fait taire la cloche ==');
const card = p.locator('.card', { hasText: orderNumber }).first();
await card.locator('[data-status="accepted"]').first().click();
await p.waitForTimeout(2000);
const atAccept = await p.evaluate(() => window.__audio.oscillators);
await p.waitForTimeout(5000);
const afterAccept = await p.evaluate(() => window.__audio.oscillators);
check('la cloche s arrete apres acceptation', afterAccept === atAccept,
  `${atAccept} -> ${afterAccept}`);
check('la commande acceptee est encore affichee',
  (await p.locator('body').innerText()).includes(orderNumber));

/* ---------------------------------------------------------------- */
console.log('\n== Le son peut etre coupe ==');
await p.evaluate(() => { window.__audio.oscillators = 0; });
await p.locator('#soundToggle').uncheck();
await p.waitForTimeout(500);
const muted = await placeOrder();
check('une seconde commande est passee', muted.status === 201);
await p.waitForTimeout(5000);
check('rien ne sonne quand le son est coupe',
  (await p.evaluate(() => window.__audio.oscillators)) === 0,
  String(await p.evaluate(() => window.__audio.oscillators)));
check('la commande arrive quand meme',
  (await p.locator('body').innerText()).includes(muted.data.order.order_number));

await p.close();

console.log('ERREURS:', errs.length ? errs.slice(0, 6) : 'aucune');
if (errs.length) fail += errs.length;
console.log(`\n  ${pass} verifications reussies, ${fail} echecs\n`);
await b.close();
process.exit(fail ? 1 : 0);
})();
