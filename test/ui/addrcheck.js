/*
 * The customer address experience, end to end in a browser.
 *
 * Covers the address screen a new visitor meets, the location button, the map
 * picker, the address book, and what checkout does with all of it. The map
 * runs against a stand-in for Leaflet (see _shared.js): the real library and
 * its tiles both come from the internet, which this machine cannot reach, so
 * what is checked here is the app's own behaviour around the map — the pin it
 * places, the coordinates it reports, the confirmation it insists on.
 */
const { chromium } = require('playwright');
const {
  dismissAddressGate, createCustomer, stubLeaflet, stubGeolocation,
  stubGeolocationDenied, apiLogin, saveAddress,
} = require('./_shared.js');

let pass = 0, fail = 0;
const check = (l, ok, extra = '') => {
  ok ? (pass++, console.log('  ok   ' + l)) : (fail++, console.log('  FAIL ' + l + ' ' + extra));
};

const BASE = 'http://localhost:3000/';

/*
 * Opens the address book.
 *
 * The banner offers "change" once an address is chosen, but a customer who
 * has none yet gets "add" instead, so the account screen is the entry point
 * that always works.
 */
async function openBook(p) {
  // count() would find the banner button on the hidden home screen too,
  // and clicking something invisible just times out.
  if (await p.locator('#bannerChange').isVisible().catch(() => false)) {
    await p.click('#bannerChange');
  } else {
    await p.click('#navAccount');
    await p.waitForTimeout(600);
    await p.click('#goAddresses');
  }
  await p.waitForSelector('#addrList', { timeout: 10000 });
  await p.waitForTimeout(500);
}

(async () => {
const b = await chromium.launch();
const errs = [];
const watch = (p) => {
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  p.on('dialog', async (d) => { await d.accept(); });
};

const customer = await createCustomer('68');

/* ---------------------------------------------------------------- */
console.log('\n== 1. L ecran d adresse avant les restaurants ==');

let p = await b.newPage({ viewport: { width: 420, height: 900 } });
watch(p);
await stubLeaflet(p);
await stubGeolocation(p);
await p.goto(BASE, { waitUntil: 'networkidle' });
await p.waitForTimeout(600);

check('l ecran d adresse s affiche avant les restaurants',
  await p.locator('#gateLocate').isVisible());
check('les restaurants ne sont pas encore visibles',
  await p.locator('.resto-card').count() === 0);
const gateText = await p.locator('#viewGate').innerText();
check('la question est posee', /adresse/i.test(gateText), gateText.slice(0, 70));
check('bouton position actuelle', await p.locator('#gateLocate').isVisible());
check('bouton choisir sur la carte', await p.locator('#gateMap').isVisible());
check('bouton saisie manuelle', await p.locator('#gateManual').isVisible());
check('la note de confidentialite est affichee',
  /uniquement|suivi/i.test(gateText), gateText.slice(-120));

/* ---------------------------------------------------------------- */
console.log('\n== 2. Position actuelle, une seule fois ==');

await p.click('#gateLocate');
await p.waitForSelector('#mapSheet', { timeout: 8000 });
check('la carte s ouvre apres la geolocalisation',
  await p.locator('#mapSheet').isVisible());

const geo = await p.evaluate(() => window.__geo);
check('la position a ete demandee exactement une fois', geo.calls === 1, String(geo.calls));
check('aucun suivi continu n a ete demarre', geo.watches === 0, String(geo.watches));

const centred = await p.evaluate(() => window.__map.state);
check('la carte est centree sur le point recu',
  Math.abs(centred.centre.lat - 33.5731) < 0.0001
  && Math.abs(centred.centre.lng - -7.5898) < 0.0001,
  JSON.stringify(centred.centre));
check('le marqueur est deplacable', centred.draggable === true);
check('les tuiles viennent d OpenStreetMap',
  /openstreetmap\.org/.test(centred.tiles || ''), String(centred.tiles));
check('les coordonnees sont affichees',
  (await p.locator('#mapCoords').innerText()).includes('33.57'),
  await p.locator('#mapCoords').innerText());

/* ---------------------------------------------------------------- */
console.log('\n== 3. Deplacer le point ==');

await p.evaluate(() => window.__map.drag(33.6, -7.62));
await p.waitForTimeout(250);
check('glisser le marqueur met les coordonnees a jour',
  (await p.locator('#mapCoords').innerText()).includes('33.60000'),
  await p.locator('#mapCoords').innerText());

await p.evaluate(() => window.__map.tap(33.58, -7.61));
await p.waitForTimeout(250);
check('taper la carte deplace le point',
  (await p.locator('#mapCoords').innerText()).includes('33.58000'),
  await p.locator('#mapCoords').innerText());

check('le point doit etre confirme avant d etre garde',
  await p.locator('#mapConfirm').isVisible());
check('on peut renoncer', await p.locator('#mapCancel').isVisible());

await p.click('#mapCancel');
await p.waitForTimeout(400);
check('renoncer a la carte ne cree aucune adresse',
  await p.locator('#mapSheet').count() === 0 && await p.locator('#gateLocate').isVisible());

/* ---------------------------------------------------------------- */
console.log('\n== 4. Le formulaire ecrit ==');

await p.click('#gateMap');
await p.waitForSelector('#mapSheet', { timeout: 8000 });
await p.evaluate(() => window.__map.tap(34.0209, -6.8416));
await p.waitForTimeout(200);
await p.click('#mapConfirm');
await p.waitForSelector('#afName', { timeout: 8000 });

for (const [id, label] of [['afName', 'destinataire'], ['afPhone', 'telephone'],
  ['afCity', 'ville'], ['afStreet', 'rue'], ['afBuilding', 'immeuble'],
  ['afFloor', 'etage'], ['afLandmark', 'repere']]) {
  check(`le formulaire demande le ${label}`, await p.locator(`#${id}`).isVisible());
}
check('le point choisi est rappele',
  (await p.locator('#afPinText').innerText()).includes('34.02'),
  await p.locator('#afPinText').innerText());
check('un selecteur de villes est propose',
  await p.locator('#cityList option').count() > 5,
  String(await p.locator('#cityList option').count()));
check('les etiquettes domicile / travail / autre sont la',
  await p.locator('#afLabels [data-label]').count() === 3,
  String(await p.locator('#afLabels [data-label]').count()));

// an anonymous visitor: the address is kept as a draft and the home opens
await p.fill('#afName', 'Ilham B.');
await p.fill('#afPhone', '0661234567');
await p.fill('#afCity', 'Rabat');
await p.fill('#afStreet', 'Avenue Hassan II, n 12');
await p.fill('#afLandmark', 'En face de la pharmacie');
await p.click('#afSave');
await p.waitForTimeout(1200);

check('apres l adresse, les restaurants s affichent',
  await p.locator('.resto-card').count() > 0,
  String(await p.locator('.resto-card').count()));
const banner = await p.locator('#viewHome').innerText();
check('l adresse choisie est affichee en haut', /Rabat|Hassan II/.test(banner),
  banner.slice(0, 120));
check('l adresse peut etre changee a tout moment',
  await p.locator('#bannerChange').isVisible());

await p.close();

/* ---------------------------------------------------------------- */
console.log('\n== 5. Refus de la geolocalisation ==');

p = await b.newPage({ viewport: { width: 420, height: 900 } });
watch(p);
await stubLeaflet(p);
await stubGeolocationDenied(p);
await p.goto(BASE, { waitUntil: 'networkidle' });
await p.waitForTimeout(600);
await p.click('#gateLocate');
await p.waitForTimeout(900);
check('un refus de position est explique',
  (await p.locator('.toast').first().innerText().catch(() => '')).length > 0,
  await p.locator('.toast').first().innerText().catch(() => '(aucun message)'));
check('l ecran d adresse reste utilisable apres un refus',
  await p.locator('#gateManual').isVisible());
await p.close();

/* ---------------------------------------------------------------- */
console.log('\n== 6. Le carnet d adresses d un client connecte ==');

p = await b.newPage({ viewport: { width: 420, height: 900 } });
watch(p);
await stubLeaflet(p);
await stubGeolocation(p);
await p.goto(BASE, { waitUntil: 'networkidle' });
await p.waitForTimeout(500);
await dismissAddressGate(p);

await p.click('#navAccount');
await p.waitForTimeout(600);
await p.fill('#liId', customer.phone);
await p.fill('#liPass', customer.password);
await p.click('#liBtn');
await p.waitForTimeout(1500);

await openBook(p);
check('le carnet d adresses s ouvre', await p.locator('#addrList').isVisible());
check('le carnet propose les trois façons d ajouter',
  await p.locator('#addrLocate').isVisible()
  && await p.locator('#addrMap').isVisible()
  && await p.locator('#addrManual').isVisible());

// --- add: home ---
await p.click('#addrManual');
await p.waitForSelector('#afName', { timeout: 8000 });
await p.fill('#afName', 'Ilham B.');
await p.fill('#afPhone', '0661234567');
await p.fill('#afCity', 'Rabat');
await p.fill('#afStreet', 'Avenue Hassan II, n 12');
await p.click('#afPinBtn');
await p.waitForSelector('#mapSheet', { timeout: 8000 });
await p.evaluate(() => window.__map.tap(34.0209, -6.8416));
await p.waitForTimeout(200);
await p.click('#mapConfirm');
await p.waitForTimeout(500);
await p.click('#afSave');
await p.waitForTimeout(1300);
check('une premiere adresse est enregistree',
  await p.locator('[data-addr]').count() === 1,
  String(await p.locator('[data-addr]').count()));
check('la premiere adresse devient celle par defaut',
  await p.locator('.addr-card .badge.green').count() === 1);

// --- add: work ---
await p.click('#addrManual');
await p.waitForSelector('#afName', { timeout: 8000 });
await p.click('#afLabels [data-label="work"]');
await p.fill('#afName', 'Ilham au bureau');
await p.fill('#afPhone', '0662222222');
await p.fill('#afCity', 'Casablanca');
await p.fill('#afStreet', 'Boulevard Zerktouni, n 44');
await p.fill('#afFloor', '5e etage');
await p.click('#afPinBtn');
await p.waitForSelector('#mapSheet', { timeout: 8000 });
await p.evaluate(() => window.__map.tap(33.5892, -7.6039));
await p.waitForTimeout(200);
await p.click('#mapConfirm');
await p.waitForTimeout(500);
await p.click('#afSave');
await p.waitForTimeout(1300);
check('un client peut avoir plusieurs adresses',
  await p.locator('[data-addr]').count() === 2,
  String(await p.locator('[data-addr]').count()));
const bookText = await p.locator('#addrList').innerText();
check('les etiquettes distinguent les adresses',
  /Travail/i.test(bookText) && /Maison/i.test(bookText), bookText.slice(0, 160));
check('chaque adresse offre un lien de carte',
  await p.locator('#addrList a[href*="google.com/maps"], #addrList a[href*="openstreetmap"]').count() >= 2,
  String(await p.locator('#addrList a.btn-like').count()));

// --- edit ---
await p.locator('[data-edit]').first().click();
await p.waitForSelector('#afStreet', { timeout: 8000 });
await p.fill('#afStreet', 'Avenue Hassan II, n 99');
await p.click('#afSave');
await p.waitForTimeout(1300);
check('une adresse peut etre modifiee',
  (await p.locator('#addrList').innerText()).includes('n 99'),
  (await p.locator('#addrList').innerText()).slice(0, 140));

// --- default ---
await p.locator('[data-default]').first().click();
await p.waitForTimeout(1300);
check('une seule adresse reste par defaut',
  await p.locator('.addr-card .badge.green').count() === 1,
  String(await p.locator('.addr-card .badge.green').count()));

// --- delete ---
const before = await p.locator('[data-addr]').count();
await p.locator('[data-del]').last().click();
await p.waitForTimeout(1400);
check('une adresse peut etre supprimee',
  await p.locator('[data-addr]').count() === before - 1,
  `${before} -> ${await p.locator('[data-addr]').count()}`);

/* ---------------------------------------------------------------- */
console.log('\n== 7. Le checkout ==');

await p.click('#homeLink');
await p.waitForTimeout(800);
await p.locator('.resto-card').first().click();
await p.waitForTimeout(1000);
await p.locator('[data-add]').first().click();
await p.waitForTimeout(700);
if (await p.locator('#confirmOpt').isVisible().catch(() => false)) {
  await p.click('#confirmOpt');
  await p.waitForTimeout(600);
}
await p.click('#goToCart');
await p.waitForTimeout(900);

const pickup = p.locator('input[name=ful][value=pickup]');
if (await pickup.count()) {
  await pickup.check();
  await p.waitForTimeout(500);
  check('une commande a emporter ne demande aucune adresse',
    await p.locator('#ckAddrList [data-pick]').count() === 0
    && !(await p.locator('#placeOrder').isDisabled()));
}

await p.locator('input[name=ful][value=delivery]').check();
await p.waitForTimeout(600);
check('la livraison propose les adresses enregistrees',
  await p.locator('#ckAddrList [data-pick]').count() >= 1,
  String(await p.locator('#ckAddrList [data-pick]').count()));
check('l adresse de livraison est affichee au checkout',
  /Hassan II|Zerktouni/.test(await p.locator('#ckAddrList').innerText()),
  (await p.locator('#ckAddrList').innerText()).slice(0, 120));
check('on peut ajouter une adresse depuis le checkout',
  await p.locator('#ckAddrAdd').isVisible());

await p.locator('#ckAddrList [data-pick]').first().check();
await p.waitForTimeout(500);
check('une adresse choisie debloque la commande',
  !(await p.locator('#placeOrder').isDisabled()));

await p.click('#placeOrder');
await p.waitForTimeout(2300);
const ordersText = await p.locator('#viewOrders').innerText();
check('la commande est passee', ordersText.includes('CMD-'), ordersText.slice(0, 120));
check('la commande rappelle l adresse de livraison',
  /Hassan II|Zerktouni/.test(ordersText), ordersText.slice(0, 200));

/* ---------------------------------------------------------------- */
console.log('\n== 8. L instantane ne bouge plus ==');

// move the address the order was placed to, then look at the order again
await openBook(p);
await p.locator('[data-edit]').first().click();
await p.waitForSelector('#afStreet', { timeout: 8000 });
await p.fill('#afStreet', 'Rue Totalement Differente, n 1');
await p.fill('#afCity', 'Agadir');
await p.click('#afSave');
await p.waitForTimeout(1400);

await p.click('#navOrders');
await p.waitForTimeout(1400);
const afterMove = await p.locator('#viewOrders').innerText();
check('modifier l adresse ne change pas la commande deja passee',
  !/Totalement Differente/.test(afterMove), afterMove.slice(0, 200));

/* ---------------------------------------------------------------- */
console.log('\n== 9. Hors zone de livraison ==');

// an address far from every demo restaurant: the warning shows, nothing hides
const far = await apiLogin(customer.phone, customer.password);
await saveAddress(far, {
  label: 'other', label_custom: 'Chez ma tante', city: 'Oujda',
  street: 'Boulevard Mohammed V, n 3', lat: 34.6814, lng: -1.9086,
});
await p.reload({ waitUntil: 'networkidle' });
await p.waitForTimeout(1200);
await openBook(p);
await p.locator('[data-addr]').filter({ hasText: 'Oujda' }).locator('[data-pick]').first().check();
await p.waitForTimeout(600);
await p.click('#homeLink');
await p.waitForTimeout(1200);
const homeText = await p.locator('#viewHome').innerText();
check('les restaurants restent tous visibles hors zone',
  await p.locator('.resto-card').count() > 0,
  String(await p.locator('.resto-card').count()));
check('un avertissement signale la zone de livraison',
  /ne livre pas|peut-etre pas|peut-être pas|hors/i.test(homeText),
  homeText.slice(0, 200));

/* ---------------------------------------------------------------- */
console.log('\n== 10. Les adresses d un autre client ==');

const stranger = await createCustomer('69');
const mine = await (await fetch('http://localhost:3000/api/me/addresses', {
  headers: { Authorization: `Bearer ${stranger.token}` },
})).json();
check('un nouveau client ne voit aucune adresse d autrui',
  (mine.addresses || []).length === 0, String((mine.addresses || []).length));

/* ---------------------------------------------------------------- */
console.log('\n== 11. Echappement de ce que le client ecrit ==');

await openBook(p);
await p.click('#addrManual');
await p.waitForSelector('#afName', { timeout: 8000 });
await p.fill('#afName', '<img src=x onerror="window.__xss=1">');
await p.fill('#afPhone', '0663333333');
await p.fill('#afCity', 'Tanger');
await p.fill('#afStreet', '<script>window.__xss=2</script> Rue Test');
await p.click('#afPinBtn');
await p.waitForSelector('#mapSheet', { timeout: 8000 });
await p.evaluate(() => window.__map.tap(35.7595, -5.834));
await p.waitForTimeout(200);
await p.click('#mapConfirm');
await p.waitForTimeout(500);
await p.click('#afSave');
await p.waitForTimeout(1400);
check('rien de ce qui est tape n est execute',
  await p.evaluate(() => window.__xss === undefined));
check('le texte dangereux est affiche tel quel',
  (await p.locator('#addrList').innerText()).includes('<img src=x'),
  (await p.locator('#addrList').innerText()).slice(0, 120));

await p.close();

/* ---------------------------------------------------------------- */
console.log('\n== 12. Ce que voient le restaurant et l administration ==');

/*
 * A courier is handed a door, not a dot. Both back-office screens have to
 * show the written detail and the pin, so this places one delivery with
 * unmistakable text in every field and then looks for it in each screen.
 */
const marker = String(Date.now()).slice(-6);
const buyerToken = await apiLogin(customer.phone, customer.password);
const placed = await saveAddress(buyerToken, {
  label: 'other', label_custom: `Repere ${marker}`, city: 'Kenitra',
  street: `Rue du Test ${marker}`, building: `Imm. B${marker}`,
  floor: `4e etage appt ${marker}`, landmark: `Face au cafe ${marker}`,
  instructions: 'Sonner deux fois', lat: 34.261, lng: -6.5802,
});
const addressId = placed.address_id;

const menu = await (await fetch('http://localhost:3000/api/restaurants/1')).json();
const products = [
  ...(menu.menu || []).flatMap((c) => c.products || []),
  ...(menu.uncategorized || []),
].filter((x) => x.is_available !== false);
// A dish with no compulsory choices keeps this section about addresses.
const firstProduct = products.find((x) => !(x.option_groups || []).some((g) => g.is_required))
  || products[0];
check('un plat est disponible pour le controle', !!firstProduct, String(products.length));
const orderRes = await fetch('http://localhost:3000/api/orders', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyerToken}` },
  body: JSON.stringify({
    restaurant_id: 1,
    fulfillment_type: 'delivery',
    address_id: addressId,
    items: [{
      product_id: firstProduct.id,
      quantity: 1,
      option_ids: (firstProduct.option_groups || [])
        .filter((g) => g.is_required)
        .flatMap((g) => (g.options || []).slice(0, Math.max(1, g.min_select || 1)).map((o) => o.id)),
    }],
  }),
});
const orderData = await orderRes.json();
check('commande de livraison creee pour le controle',
  orderRes.status === 201, `${orderRes.status} ${JSON.stringify(orderData).slice(0, 130)}`);
const orderNumber = orderData.order && orderData.order.order_number;

// --- the restaurant dashboard ---
const rp = await b.newPage({ viewport: { width: 1280, height: 950 } });
watch(rp);
await rp.goto('http://localhost:3000/restaurant.html', { waitUntil: 'networkidle' });
await rp.fill('#liId', 'resto1@demo.ma');
await rp.fill('#liPass', 'resto1234');
await rp.click('#liBtn');
await rp.waitForTimeout(2400);
const rText = await rp.locator('body').innerText();
check('le restaurant voit le nom du client', /Client Adresse/.test(rText), rText.slice(0, 120));
check('le restaurant voit le telephone du client', rText.includes(customer.phone), customer.phone);
check('le restaurant voit la rue', rText.includes(`Rue du Test ${marker}`));
check('le restaurant voit immeuble et etage',
  rText.includes(`Imm. B${marker}`) && rText.includes(`4e etage appt ${marker}`));
check('le restaurant voit le repere', rText.includes(`Face au cafe ${marker}`));
check('le restaurant a un lien vers la carte',
  await rp.locator('a[href*="34.261"]').count() > 0,
  String(await rp.locator('a.btn-like').count()));
await rp.close();

// --- the admin order detail ---
const ap = await b.newPage({ viewport: { width: 1320, height: 950 } });
watch(ap);
await ap.goto('http://localhost:3000/admin.html', { waitUntil: 'networkidle' });
await ap.fill('#email', '0600000000');
await ap.fill('#pass', 'admin1234');
await ap.click('#btn');
await ap.waitForSelector('.sidebar', { timeout: 10000 });
await ap.click('[data-section="orders"]');
await ap.waitForTimeout(2200);
// the list shows a one-line address; the full detail is behind the row button
check('la commande figure dans la liste admin',
  await ap.locator('tr', { hasText: orderNumber }).count() > 0, String(orderNumber));
await ap.locator('tr', { hasText: orderNumber }).first().locator('[data-order]').click();
await ap.waitForTimeout(2000);
const aText = await ap.locator('body').innerText();
check('l administration voit le nom du client', /Client Adresse/.test(aText));
check('l administration voit le telephone', aText.includes(customer.phone));
check('l administration voit l adresse complete',
  aText.includes(`Rue du Test ${marker}`), aText.slice(0, 160));
check('l administration voit immeuble, etage et repere',
  aText.includes(`Imm. B${marker}`) && aText.includes(`4e etage appt ${marker}`)
  && aText.includes(`Face au cafe ${marker}`));
check('l administration a un lien vers la carte',
  await ap.locator('a[href*="34.261"]').count() > 0);
await ap.close();

console.log('ERREURS:', errs.length ? errs.slice(0, 6) : 'aucune');
if (errs.length) fail += errs.length;
console.log(`\n  ${pass} verifications reussies, ${fail} echecs\n`);
await b.close();
process.exit(fail ? 1 : 0);
})();
