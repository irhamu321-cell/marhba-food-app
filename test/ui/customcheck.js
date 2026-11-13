/*
 * Ingredient customization and allergy notes, through the browser.
 *
 * A dish with one paid extra and two removals is put on the menu, ordered
 * with an allergy note, and then looked for on the kitchen ticket and in the
 * admin detail — the two screens where getting an allergy wrong matters.
 */
const { chromium } = require('playwright');
const { dismissAddressGate, createCustomer, apiLogin } = require('./_shared.js');

let pass = 0, fail = 0;
const check = (l, ok, extra = '') => {
  ok ? (pass++, console.log('  ok   ' + l)) : (fail++, console.log('  FAIL ' + l + ' ' + extra));
};

const BASE = 'http://localhost:3000';
const api = async (path, token, body, method = 'POST') => {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(data).slice(0, 140)}`);
  return data;
};

(async () => {
const b = await chromium.launch();
const errs = [];
const watch = (p) => {
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  p.on('dialog', async (d) => { await d.accept(); });
};

const stamp = String(Date.now()).slice(-6);
const dish = `Burger perso ${stamp}`;
const rToken = await apiLogin('resto1@demo.ma', 'resto1234');

console.log('\n== Mise en place du plat ==');
const product = (await api('/restaurant/products', rToken, {
  category_id: null, name: dish, name_ar: `برغر ${stamp}`, price_cents: 4000,
  description: 'Plat de test', description_ar: '',
})).product;
const extras = (await api('/restaurant/option-groups', rToken, {
  product_id: product.id, name: 'Suppléments', name_ar: 'إضافات', min_select: 0, max_select: 3,
})).group;
const outs = (await api('/restaurant/option-groups', rToken, {
  product_id: product.id, name: 'Retirer', name_ar: 'حذف', min_select: 0, max_select: 1,
})).group;
await api('/restaurant/options', rToken, {
  option_group_id: extras.id, name: 'Double fromage', name_ar: 'جبن مزدوج', price_delta_cents: 500,
});
const onion = (await api('/restaurant/options', rToken, {
  option_group_id: outs.id, name: 'Sans oignons', name_ar: 'بدون بصل', is_removal: true,
  price_delta_cents: 700,
})).option;
await api('/restaurant/options', rToken, {
  option_group_id: outs.id, name: 'Sans sauce piquante', name_ar: 'بدون صوص حار', is_removal: true,
});
check('le retrait est enregistre sans prix', Number(onion.price_delta_cents) === 0,
  String(onion.price_delta_cents));

const customer = await createCustomer('66');

console.log('\n== Le client personnalise son plat ==');
const p = await b.newPage({ viewport: { width: 420, height: 900 } });
watch(p);
await p.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await p.waitForTimeout(500);
await dismissAddressGate(p);

await p.click('#navAccount');
await p.waitForTimeout(600);
await p.fill('#liId', customer.phone);
await p.fill('#liPass', customer.password);
await p.click('#liBtn');
await p.waitForTimeout(1500);

await p.click('#homeLink');
await p.waitForTimeout(900);
await p.fill('#search', 'Snack Atlas');
await p.waitForTimeout(900);
await p.locator('[data-resto]').filter({ hasText: 'Snack Atlas' }).first().click();
await p.waitForTimeout(1200);

const dishCard = p.locator('.item', { hasText: dish }).first();
await dishCard.locator('[data-add]').first().click();
await p.waitForSelector('.modal', { timeout: 8000 });

const modal = await p.locator('.modal').innerText();
check('le supplement paye affiche son prix', /Double fromage/.test(modal) && /\+/.test(modal),
  modal.slice(0, 160));
check('les retraits sont proposes', /Sans oignons/.test(modal) && /Sans sauce piquante/.test(modal));
check('un retrait est marque comme retire',
  await p.locator('.optrow.removal').count() === 2,
  String(await p.locator('.optrow.removal').count()));
check('un retrait n affiche aucun prix',
  !(await p.locator('.optrow.removal').first().innerText()).includes('+'),
  await p.locator('.optrow.removal').first().innerText());
check('aucun retrait n est coche par defaut',
  await p.locator('.optrow.removal input:checked').count() === 0);

const priceBefore = await p.locator('#optTotal').innerText();
await p.locator('.optrow.removal input').first().check();
await p.locator('.optrow.removal input').nth(1).check();
await p.waitForTimeout(250);
check('deux retraits peuvent etre coches en meme temps',
  await p.locator('.optrow.removal input:checked').count() === 2);
check('un retrait ne change pas le prix',
  (await p.locator('#optTotal').innerText()) === priceBefore,
  `${priceBefore} -> ${await p.locator('#optTotal').innerText()}`);

await p.locator('.optrow:not(.removal) input[type=checkbox]').first().check();
await p.waitForTimeout(250);
check('le supplement augmente le prix',
  (await p.locator('#optTotal').innerText()) !== priceBefore,
  await p.locator('#optTotal').innerText());

await p.click('#confirmOpt');
await p.waitForTimeout(800);

console.log('\n== Le panier et la consigne allergie ==');
await p.click('#goToCart');
await p.waitForTimeout(900);
const cart = await p.locator('#viewCart').innerText();
check('le panier marque les retraits par une croix', cart.includes('✕ Sans oignons'),
  cart.slice(0, 200));
check('le panier montre aussi le supplement', /Double fromage/.test(cart));
check('le champ allergie est propose', await p.locator('#ckAllergy').isVisible());

const allergy = `ALLERGIE ARACHIDES ${stamp} - aucune huile de cacahuete`;
await p.fill('#ckAllergy', allergy);
await p.locator('input[name=ful][value=pickup]').check();
await p.waitForTimeout(500);
await p.click('#placeOrder');
await p.waitForTimeout(2400);
const orders = await p.locator('#viewOrders').innerText();
check('la commande est passee', orders.includes('CMD-'), orders.slice(0, 120));
const orderNumber = (orders.match(/CMD-[A-Z0-9-]+/) || [''])[0];
await p.close();

console.log('\n== Le ticket de cuisine ==');
const rp = await b.newPage({ viewport: { width: 1280, height: 950 } });
watch(rp);
await rp.goto(`${BASE}/restaurant.html`, { waitUntil: 'networkidle' });
await rp.fill('#liId', 'resto1@demo.ma');
await rp.fill('#liPass', 'resto1234');
await rp.click('#liBtn');
await rp.waitForTimeout(2400);
const ticket = await rp.locator('body').innerText();
check('la consigne allergie apparait sur le ticket', ticket.includes(allergy),
  ticket.slice(0, 180));
check('le ticket porte un avertissement', /Allergies|consignes/i.test(ticket));
check('le ticket separe les retraits', /SANS/i.test(ticket), ticket.slice(0, 200));
check('le ticket nomme les ingredients retires',
  ticket.includes('Sans oignons') && ticket.includes('Sans sauce piquante'));
check('le ticket nomme le supplement', ticket.includes('Double fromage'));
check('l avertissement allergie est dans un encadre',
  await rp.locator('.alert.warn', { hasText: allergy }).count() > 0);
await rp.close();

console.log('\n== Le detail cote administration ==');
const ap = await b.newPage({ viewport: { width: 1320, height: 950 } });
watch(ap);
await ap.goto(`${BASE}/admin.html`, { waitUntil: 'networkidle' });
await ap.fill('#email', '0600000000');
await ap.fill('#pass', 'admin1234');
await ap.click('#btn');
await ap.waitForSelector('.sidebar', { timeout: 10000 });
await ap.click('[data-section="orders"]');
await ap.waitForTimeout(2200);
check('la liste admin signale la commande par une pastille',
  await ap.locator('tr', { hasText: orderNumber }).locator('.badge.amber').count() > 0,
  orderNumber);
await ap.locator('tr', { hasText: orderNumber }).first().locator('[data-order]').click();
await ap.waitForTimeout(2000);
const detail = await ap.locator('body').innerText();
check('le detail admin affiche la consigne allergie', detail.includes(allergy),
  detail.slice(0, 180));
check('le detail admin separe les retraits', /SANS/i.test(detail));
check('le detail admin nomme le supplement', detail.includes('Double fromage'));
check('l avertissement admin est dans un encadre',
  await ap.locator('.alert.warn', { hasText: allergy }).count() > 0);
await ap.close();

console.log('ERREURS:', errs.length ? errs.slice(0, 6) : 'aucune');
if (errs.length) fail += errs.length;
console.log(`\n  ${pass} verifications reussies, ${fail} echecs\n`);
await b.close();
process.exit(fail ? 1 : 0);
})();
