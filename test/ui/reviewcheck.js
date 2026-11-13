/*
 * Rating an order, and what the rating changes.
 *
 * The part worth testing is not the modal — it is that the number a customer
 * sees on a restaurant card is the average of reviews that exist. A star
 * rating with nothing behind it is a claim made to someone deciding where to
 * spend their money, so this checks both directions: a rated restaurant shows
 * its real average, and an unrated one says so instead of showing a number.
 */
const { chromium } = require('playwright');
const { dismissAddressGate, createCustomer, createRestaurant, apiLogin } = require('./_shared.js');

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

(async () => {
const b = await chromium.launch();
const errs = [];
const watch = (p) => {
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  p.on('dialog', async (d) => { await d.accept(); });
};

const rToken = await apiLogin('resto1@demo.ma', 'resto1234');
const customer = await createCustomer('65');

/* A dish with no compulsory choices, and an order carried to completed. */
const menu = (await api('/restaurants/1')).data;
const products = [
  ...(menu.menu || []).flatMap((c) => c.products || []),
  ...(menu.uncategorized || []),
].filter((x) => x.is_available !== false);
const dish = products.find((x) => !(x.option_groups || []).some((g) => g.is_required)) || products[0];

const completeOne = async () => {
  const placed = await api('/orders', { method: 'POST', token: customer.token, body: {
    restaurant_id: 1, fulfillment_type: 'pickup',
    items: [{ product_id: dish.id, quantity: 1 }] } });
  const id = placed.data.order.id;
  for (const status of ['accepted', 'preparing', 'ready', 'completed']) {
    await api(`/restaurant/orders/${id}/status`,
      { method: 'POST', token: rToken, body: { status, note: '' } });
  }
  return placed.data.order;
};
const order = await completeOne();
const before = (await api('/restaurants/1/reviews')).data;

/* ---------------------------------------------------------------- */
console.log('\n== Le bouton de notation ==');
const p = await b.newPage({ viewport: { width: 420, height: 950 } });
watch(p);
await p.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await p.waitForTimeout(500);
await dismissAddressGate(p);
await p.click('#navAccount');
await p.waitForTimeout(600);
await p.fill('#liId', customer.phone);
await p.fill('#liPass', customer.password);
await p.click('#liBtn');
await p.waitForTimeout(1600);

await p.click('#navOrders');
await p.waitForTimeout(1600);
const card = p.locator('.card', { hasText: order.order_number }).first();
check('la commande terminee propose de la noter',
  await card.locator('[data-rate]').count() === 1,
  order.order_number);

/* ---------------------------------------------------------------- */
console.log('\n== La fenetre de notation ==');
await card.locator('[data-rate]').click();
await p.waitForSelector('#starPick', { timeout: 8000 });
check('cinq niveaux sont proposes', await p.locator('[data-star]').count() === 5,
  String(await p.locator('[data-star]').count()));
check('les etoiles sont des boutons radio accessibles',
  (await p.locator('[data-star]').first().getAttribute('type')) === 'radio');
check('chaque niveau porte un mot',
  /Excellent/i.test(await p.locator('#starPick').innerText()),
  (await p.locator('#starPick').innerText()).replace(/\n/g, ' | ').slice(0, 120));
check('un commentaire est propose', await p.locator('#revComment').isVisible());
check('envoyer est bloque avant tout choix',
  await p.locator('#revSend').isDisabled());

const comment = `Tres bon, teste le ${Date.now() % 100000}`;
await p.locator('[data-star="4"]').check();
await p.waitForTimeout(250);
check('envoyer se debloque une fois la note choisie',
  !(await p.locator('#revSend').isDisabled()));
await p.fill('#revComment', comment);
await p.click('#revSend');
await p.waitForTimeout(2200);

check('la fenetre se referme', await p.locator('#starPick').count() === 0);
check('un remerciement est affiche',
  /Merci/i.test(await p.locator('.toast').first().innerText().catch(() => '')),
  await p.locator('.toast').first().innerText().catch(() => '(aucun)'));

/* ---------------------------------------------------------------- */
console.log('\n== Ce que la note a change ==');
const after = (await api('/restaurants/1/reviews')).data;
check('un avis de plus est enregistre',
  after.reviews_count === before.reviews_count + 1,
  `${before.reviews_count} -> ${after.reviews_count}`);
check('le commentaire est publie',
  after.reviews.some((r) => r.comment === comment), comment);
check('la note enregistree est celle choisie',
  (after.reviews.find((r) => r.comment === comment) || {}).rating === 4);
check('la moyenne correspond aux avis',
  Math.abs(after.rating - after.reviews.reduce((t, r) => t + r.rating, 0) / after.reviews.length) < 0.0002,
  String(after.rating));

await p.click('#navOrders');
await p.waitForTimeout(1700);
const rated = p.locator('.card', { hasText: order.order_number }).first();
check('la commande notee n offre plus de la noter',
  await rated.locator('[data-rate]').count() === 0);
check('la note donnee est rappelee',
  (await rated.innerText()).includes('★★★★'),
  (await rated.innerText()).replace(/\n/g, ' | ').slice(-90));

/* ---------------------------------------------------------------- */
console.log('\n== Sur la fiche du restaurant ==');
await p.click('#homeLink');
await p.waitForTimeout(1200);
await p.fill('#search', 'Snack Atlas');
await p.waitForTimeout(1000);
const homeCard = p.locator('[data-resto]').filter({ hasText: 'Snack Atlas' }).first();
const homeText = await homeCard.innerText();
check('la carte affiche la note et le nombre d avis',
  homeText.includes(after.rating.toFixed(1)) && homeText.includes(`(${after.reviews_count})`),
  homeText.replace(/\n/g, ' | '));

await homeCard.click();
await p.waitForTimeout(1800);
await p.waitForSelector('#restoReviews .listrow', { timeout: 8000 }).catch(() => {});
const panel = await p.locator('#restoReviews').innerText();
check('la fiche liste les avis', panel.includes(comment), panel.slice(0, 180));
check('la fiche montre la moyenne', panel.includes(after.rating.toFixed(1)));
check('la fiche montre le nombre d avis',
  panel.includes(String(after.reviews_count)), panel.slice(0, 120));
check('la repartition par etoile est dessinee',
  await p.locator('#restoReviews .revbar').count() === 5,
  String(await p.locator('#restoReviews .revbar').count()));
check('le nom complet de l auteur n est pas publie',
  !panel.includes('Client Adresse'), panel.slice(0, 160));

/* ---------------------------------------------------------------- */
console.log('\n== Un restaurant sans aucun avis ==');
/*
 * A restaurant with no reviews must not show a number. This creates one, so
 * the case is real rather than assumed.
 */
const fresh = await createRestaurant('64');
const listed = (await api('/restaurants')).data.restaurants.find((r) => r.id === fresh.restaurantId);
check('le nouveau restaurant a zero avis',
  listed && Number(listed.reviews_count) === 0, String(listed && listed.reviews_count));

await p.click('#homeLink');
await p.waitForTimeout(1000);
await p.fill('#search', fresh.name);
await p.waitForTimeout(1300);
const freshCard = p.locator('[data-resto]').filter({ hasText: fresh.name }).first();
check('le nouveau restaurant est visible', await freshCard.count() === 1, fresh.name);
if (await freshCard.count()) {
  const freshText = await freshCard.innerText();
  check('il est marque "Nouveau" au lieu d une note',
    /Nouveau/i.test(freshText), freshText.replace(/\n/g, ' | '));
  check('aucune note chiffree n est affichee',
    !/\u2605\s*\d/.test(freshText), freshText.replace(/\n/g, ' | '));
}

await p.close();

console.log('ERREURS:', errs.length ? errs.slice(0, 6) : 'aucune');
if (errs.length) fail += errs.length;
console.log(`\n  ${pass} verifications reussies, ${fail} echecs\n`);
await b.close();
process.exit(fail ? 1 : 0);
})();
