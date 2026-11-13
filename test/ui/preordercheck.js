/* Customer side: cuisine and service filters, then a full pre-order. */
const { chromium } = require('playwright');
const { dismissAddressGate, saveAddress, apiLogin } = require('./_shared.js');
let pass = 0, fail = 0;
const check = (l, ok, extra='') => { ok ? (pass++, console.log('  ok   '+l)) : (fail++, console.log('  FAIL '+l+' '+extra)); };

(async () => {
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 420, height: 920 } });
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

await p.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
await dismissAddressGate(p);
await p.waitForSelector('.resto-card', { timeout: 10000 });

const all = await p.locator('.resto-card').count();
check('restaurants affiches', all >= 10, String(all));
check('badges de service affiches', await p.locator('.badge.immediate, .badge.preorder').count() > 0);
check('notes affichees', await p.locator('.rating').count() > 0);

// --- cuisine filter ---
await p.click('[data-cuisine="italienne"]');
await p.waitForTimeout(700);
const italian = await p.locator('.resto-card').count();
check('filtre cuisine italienne reduit la liste', italian > 0 && italian < all, `${italian}/${all}`);
const names = await p.locator('.resto-card h3').allInnerTexts();
check('Bella Napoli dans les italiens', names.some((n) => n.includes('Bella Napoli')), names.join(','));

// --- service filter on top of cuisine ---
await p.click('[data-service="preorder"]');
await p.waitForTimeout(700);
const both = await p.locator('.resto-card h3').allInnerTexts();
check('italien + precommande', both.length > 0 && both.length < italian, both.join(','));
check('Roma Gourmet present', both.some((n) => n.includes('Roma Gourmet')), both.join(','));
check('Bella Napoli absent (immediat)', !both.some((n) => n.includes('Bella Napoli')), both.join(','));

// --- reset ---
await p.click('#clearFilters');
await p.waitForTimeout(700);
check('reinitialisation restaure la liste', await p.locator('.resto-card').count() === all);

// --- search ---
await p.fill('#search', 'Sushi');
await p.waitForTimeout(900);
const found = await p.locator('.resto-card h3').allInnerTexts();
check('recherche par nom', found.length >= 1 && found.every((n) => n.toLowerCase().includes('sushi')), found.join(','));
await p.click('#clearFilters');
await p.waitForTimeout(700);

// --- open a pre-order restaurant ---
await p.click('[data-service="preorder"]');
await p.waitForTimeout(700);
await p.locator('.resto-card', { hasText: 'Roma Gourmet' }).click();
await p.waitForSelector('#slotPicker', { timeout: 8000 });
check('message precommande affiche', await p.locator('.preorder-note').isVisible());
check('selecteur de dates affiche', await p.locator('.daycard').count() > 0);
check('creneaux affiches', await p.locator('.slotbtn').count() > 0);

/*
 * Delivery now needs a saved address with a map pin, not a line of typed
 * text. It is created through the API before signing in, because the app
 * loads the address book as part of the login, so by the time this suite
 * reaches the cart the address is already there — no reload, which would
 * lose the pre-order day and slot chosen above.
 *
 * addrcheck.js is the suite that exercises the address screens themselves.
 */
{
  const seedToken = await apiLogin('0633333333', 'client1234');
  await saveAddress(seedToken, {
    city: 'Kenitra', street: '12 Avenue Mohammed V', lat: 34.261, lng: -6.5802,
  });
}

// --- log in as the demo customer ---
await p.click('#navAccount');
await p.waitForTimeout(600);
await p.fill('#liId', '0633333333');
await p.fill('#liPass', 'client1234');
await p.click('#liBtn');
await p.waitForTimeout(1500);

// back to the restaurant, choose a day and slot, add a dish
await p.click('#homeLink');
await p.waitForTimeout(900);
await p.click('[data-service="preorder"]');
await p.waitForTimeout(700);
await p.locator('.resto-card', { hasText: 'Roma Gourmet' }).click();
await p.waitForSelector('.daycard', { timeout: 8000 });

await p.locator('.daycard').first().click();
await p.waitForTimeout(400);
await p.locator('.slotbtn').first().click();
await p.waitForTimeout(400);
check('recapitulatif de livraison affiche', await p.locator('#scheduleSummary').isVisible());

const chosenDay = await p.locator('.daycard.active .dnum').innerText();
const chosenSlot = await p.locator('.slotbtn.active').innerText();

// a dish above the minimum order (120 MAD)
await p.locator('[data-add]').nth(2).click();
await p.waitForTimeout(600);
if (await p.locator('#confirmOpt').count()) {
  const required = await p.locator('.optgroup input[type=radio]').count();
  if (required) await p.locator('.optgroup input[type=radio]').first().check();
  await p.click('#confirmOpt');
  await p.waitForTimeout(500);
}
await p.locator('[data-add]').nth(2).click();
await p.waitForTimeout(600);
if (await p.locator('#confirmOpt').count()) {
  const required = await p.locator('.optgroup input[type=radio]').count();
  if (required) await p.locator('.optgroup input[type=radio]').first().check();
  await p.click('#confirmOpt');
  await p.waitForTimeout(500);
}

await p.click('#goToCart');
await p.waitForTimeout(900);
check('panier rappelle la date choisie', (await p.locator('#viewCart').innerText()).includes(chosenSlot.trim()),
  chosenSlot);

await p.locator('input[name=ful][value=delivery]').check();
await p.waitForTimeout(700);
check('adresse enregistree visible au checkout', await p.locator('[data-pick]').count() >= 1);
await p.locator('[data-pick]').first().check();
await p.waitForTimeout(400);
check('une seule adresse selectionnee', await p.locator('.addr-card.on').count() === 1);
check('bouton commander actif', !(await p.locator('#placeOrder').isDisabled()));

await p.click('#placeOrder');
await p.waitForTimeout(2200);
const ordersText = await p.locator('#viewOrders').innerText();
check('commande creee', ordersText.includes('CMD-'), ordersText.slice(0, 120));
check('commande marquee precommande', /Précommande/i.test(ordersText), ordersText.slice(0, 200));
check('date de livraison rappelee', ordersText.includes(chosenDay.trim()), chosenDay);
check('etapes de suivi affichees', await p.locator('.steps .stepitem').count() >= 5);

console.log('ERREURS:', errs.length ? errs.slice(0, 6) : 'aucune');
if (errs.length) fail += errs.length;
console.log(`\n  ${pass} verifications reussies, ${fail} echecs\n`);
await b.close();
process.exit(fail ? 1 : 0);
})();
