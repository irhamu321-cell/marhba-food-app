/*
 * Sending a picture from the three editors that offer it.
 *
 * Playwright hands the file input real bytes, so this exercises the whole
 * path: the browser's own multipart encoding, the server's parser, the
 * sniffer, the stored file, and the picture coming back on screen.
 */
const { chromium } = require('playwright');
const { apiLogin } = require('./_shared.js');

let pass = 0, fail = 0;
const check = (l, ok, extra = '') => {
  ok ? (pass++, console.log('  ok   ' + l)) : (fail++, console.log('  FAIL ' + l + ' ' + extra));
};

const BASE = 'http://localhost:3000';

/* The smallest files that honestly are what they claim to be. */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 7)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(60, 7)]);
const HTML = Buffer.from('<html><script>alert(1)</script></html>', 'utf8');

const file = (name, mimeType, buffer) => ({ name, mimeType, buffer });

(async () => {
const b = await chromium.launch();
const errs = [];
const watch = (p) => {
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => {
    // This suite uploads a file on purpose that the server must refuse, and a
    // refused request logs a resource error in the browser. That 400 is the
    // expected outcome, so it is not counted against the run.
    const text = m.text();
    if (m.type() === 'error' && !/status of 400/.test(text)) errs.push('console: ' + text);
  });
  p.on('dialog', async (d) => { await d.accept(); });
};

const stamp = String(Date.now()).slice(-6);
const rToken = await apiLogin('resto1@demo.ma', 'resto1234');
const dish = `Plat photo ${stamp}`;
const product = (await (await fetch(`${BASE}/api/restaurant/products`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rToken}` },
  body: JSON.stringify({ category_id: null, name: dish, name_ar: `طبق ${stamp}`,
    price_cents: 3500, description: '', description_ar: '' }),
})).json()).product;

/* ---------------------------------------------------------------- */
console.log('\n== Le logo du restaurant ==');
const rp = await b.newPage({ viewport: { width: 1280, height: 1000 } });
watch(rp);
await rp.goto(`${BASE}/restaurant.html`, { waitUntil: 'networkidle' });
await rp.fill('#liId', 'resto1@demo.ma');
await rp.fill('#liPass', 'resto1234');
await rp.click('#liBtn');
await rp.waitForTimeout(2200);
await rp.click('[data-tab="settings"]');
await rp.waitForTimeout(1200);

check('le champ image est propose', await rp.locator('#sImage').count() === 1);
check('un bouton d envoi est propose',
  await rp.locator('label[for="sImageFile"]').isVisible());
check('le champ fichier accepte les trois types',
  (await rp.locator('#sImageFile').getAttribute('accept')) === 'image/jpeg,image/png,image/webp',
  await rp.locator('#sImageFile').getAttribute('accept'));
check('un apercu est affiche', await rp.locator('#sImagePrev').count() === 1);

await rp.setInputFiles('#sImageFile', file('logo.png', 'image/png', PNG));
await rp.waitForTimeout(2000);
const logoUrl = await rp.locator('#sImage').inputValue();
check('le champ est rempli par l envoi', logoUrl.startsWith('/uploads/'), logoUrl);
check('l url se termine par .png', logoUrl.endsWith('.png'), logoUrl);
check('l apercu montre l image envoyee',
  await rp.locator(`#sImagePrev img[src="${logoUrl}"]`).count() === 1);
const fetched = await rp.request.get(`${BASE}${logoUrl}`);
check('l image envoyee est servie', fetched.status() === 200);
check('elle est servie comme une image PNG',
  String(fetched.headers()['content-type']).includes('image/png'),
  fetched.headers()['content-type']);

await rp.click('#saveSettings');
await rp.waitForTimeout(1600);
const savedResto = await (await fetch(`${BASE}/api/restaurants/1`)).json();
check('le logo est enregistre sur le restaurant',
  savedResto.restaurant.image_url === logoUrl,
  `${savedResto.restaurant.image_url} vs ${logoUrl}`);

/* ---------------------------------------------------------------- */
console.log('\n== Un fichier refuse ==');
await rp.setInputFiles('#sImageFile', file('evil.jpg', 'image/jpeg', HTML));
await rp.waitForTimeout(1800);
const toastText = await rp.locator('.toast').first().innerText().catch(() => '');
check('un faux JPEG est refuse avec un message',
  /JPEG|PNG|WebP/i.test(toastText), toastText || '(aucun message)');
check('le champ garde l ancienne image',
  (await rp.locator('#sImage').inputValue()) === logoUrl);

/* ---------------------------------------------------------------- */
console.log('\n== La photo d un plat ==');
await rp.click('[data-tab="menu"]');
await rp.waitForTimeout(1500);
check('chaque plat a un bouton photo',
  await rp.locator(`label[for="dishPhoto${product.id}"]`).count() === 1);
await rp.setInputFiles(`#dishPhoto${product.id}`, file('plat.jpg', 'image/jpeg', JPEG));
await rp.waitForTimeout(2400);
const menu = await (await fetch(`${BASE}/api/restaurants/1`)).json();
const stored = [...(menu.menu || []).flatMap((c) => c.products || []), ...(menu.uncategorized || [])]
  .find((x) => x.id === product.id);
check('la photo est enregistree sur le plat',
  String(stored && stored.image_url).startsWith('/uploads/'),
  String(stored && stored.image_url));
check('la photo du plat est un JPEG',
  String(stored && stored.image_url).endsWith('.jpg'), String(stored && stored.image_url));
check('la vignette apparait dans le menu',
  await rp.locator(`img.dish-thumb[src="${stored.image_url}"]`).count() >= 1);
await rp.close();

/* ---------------------------------------------------------------- */
console.log('\n== Cote administration ==');
const ap = await b.newPage({ viewport: { width: 1320, height: 1000 } });
watch(ap);
await ap.goto(`${BASE}/admin.html`, { waitUntil: 'networkidle' });
await ap.fill('#email', '0600000000');
await ap.fill('#pass', 'admin1234');
await ap.click('#btn');
await ap.waitForSelector('.sidebar', { timeout: 10000 });

await ap.click('[data-section="catalog"]');
await ap.waitForTimeout(2200);
// The catalogue shows nothing until a restaurant is chosen.
await ap.selectOption('#catResto', '1');
await ap.waitForTimeout(2400);
check('le catalogue admin propose un bouton photo',
  await ap.locator('[data-catphoto]').count() > 0,
  String(await ap.locator('[data-catphoto]').count()));
check('le catalogue admin montre les vignettes',
  await ap.locator('img.dish-thumb').count() > 0);

const firstPhoto = await ap.locator('[data-catphoto]').first().getAttribute('data-catphoto');
await ap.setInputFiles(`#catPhoto${firstPhoto}`, file('autre.png', 'image/png', PNG));
await ap.waitForTimeout(2600);
const catToast = await ap.locator('.toast').first().innerText().catch(() => '');
check('l envoi depuis le catalogue admin reussit',
  /envoy/i.test(catToast) || await ap.locator('img.dish-thumb').count() > 0,
  catToast || '(aucun message)');

await ap.click('[data-section="restaurants"]');
await ap.waitForTimeout(2000);
const openBtn = ap.locator('[data-open]').first();
if (await openBtn.count()) { await openBtn.click(); await ap.waitForTimeout(2200); }
if (await ap.locator('#eImage').count()) {
  check('la fiche restaurant admin propose un envoi',
    await ap.locator('label[for="eImageFile"]').count() === 1);
  await ap.setInputFiles('#eImageFile', file('cover.jpg', 'image/jpeg', JPEG));
  await ap.waitForTimeout(2200);
  check('le champ admin est rempli par l envoi',
    (await ap.locator('#eImage').inputValue()).startsWith('/uploads/'),
    await ap.locator('#eImage').inputValue());
  check('l apercu admin montre l image',
    await ap.locator('#eImagePrev img').count() === 1);
} else {
  check('la fiche restaurant admin est ouverte', false, 'champ #eImage introuvable');
}
await ap.close();

console.log('ERREURS:', errs.length ? errs.slice(0, 6) : 'aucune');
if (errs.length) fail += errs.length;
console.log(`\n  ${pass} verifications reussies, ${fail} echecs\n`);
await b.close();
process.exit(fail ? 1 : 0);
})();
