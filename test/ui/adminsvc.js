/* Admin side: filter by cuisine/service and edit a restaurant's service type. */
const { chromium } = require('playwright');
let pass = 0, fail = 0;
const check = (l, ok, extra='') => { ok ? (pass++, console.log('  ok   '+l)) : (fail++, console.log('  FAIL '+l+' '+extra)); };

(async () => {
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1320, height: 950 } });
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

await p.goto('http://localhost:3000/admin.html', { waitUntil: 'networkidle' });
await p.fill('#email', '0600000000');
await p.fill('#pass', 'admin1234');
await p.click('#btn');
await p.waitForSelector('.sidebar', { timeout: 10000 });

await p.click('[data-section="restaurants"]');
await p.waitForSelector('#fCuisine', { timeout: 8000 });
const total = await p.locator('tbody tr').count();
check('liste des restaurants chargee', total >= 10, String(total));
check('colonne type de service', (await p.locator('thead').innerText()).toLowerCase().includes('service'));
check('badges de service dans le tableau', await p.locator('.badge.immediate, .badge.preorder').count() > 0);

// filter by cuisine
await p.selectOption('#fCuisine', 'italienne');
await p.waitForTimeout(900);
const italian = await p.locator('tbody tr').count();
check('filtre cuisine', italian > 0 && italian < total, `${italian}/${total}`);

// add the service filter
await p.selectOption('#fService', 'preorder');
await p.waitForTimeout(900);
const both = await p.locator('tbody tr').count();
check('filtre cuisine + service', both > 0 && both <= italian, `${both}/${italian}`);
const rows = await p.locator('tbody tr').allInnerTexts();
check('seulement des precommandes', rows.every((r) => /Précommande/i.test(r)), rows.join(' | ').slice(0, 150));

// search
await p.selectOption('#fCuisine', '');
await p.selectOption('#fService', '');
await p.waitForTimeout(800);
await p.fill('#fQ', 'Dar Zaki');
await p.waitForTimeout(900);
check('recherche par nom', (await p.locator('tbody tr').count()) === 1, String(await p.locator('tbody tr').count()));

await p.click('#fReset');
await p.waitForTimeout(900);
check('reinitialisation', (await p.locator('tbody tr').count()) === total);

// --- open an immediate restaurant and make it a pre-order one ---
await p.fill('#fQ', 'Le Grill Royal');
await p.waitForTimeout(900);
await p.locator('[data-open]').first().click();
await p.waitForSelector('#aSvcSwitch', { timeout: 8000 });
check('editeur de service present', await p.locator('[data-asvc="preorder"]').isVisible());
check('selecteur de cuisines present', await p.locator('[data-acuisine]').count() > 0);
check('note modifiable', await p.locator('#aRating').isVisible());

await p.click('[data-asvc="preorder"]');
await p.waitForTimeout(400);
check('config precommande visible', !(await p.locator('#aSvcConfig').evaluate((el) => el.classList.contains('hidden'))));

await p.selectOption('#aPrepHours', '72');
await p.locator('[data-adaychip="5"]').click();
await p.locator('[data-adaychip="6"]').click();
await p.fill('#aSlots', '12:00-14:00\n20:00-22:00');
await p.fill('#aCutoff', '15:00');
await p.locator('[data-acuisine="healthy"]').click();
await p.fill('#aRating', '4.1');
await p.click('#saveService');
await p.waitForTimeout(1800);

const detail = await p.locator('#content').innerText();
check('precommande 72h enregistree', /72/.test(detail), detail.slice(0, 200));
check('creneaux enregistres', detail.includes('12:00-14:00'), detail.slice(0, 300));
check('heure limite enregistree', detail.includes('15:00'));
check('cuisine ajoutee', /Healthy/i.test(detail));
check('note enregistree', detail.includes('4.1'));

// --- the orders screen filters by service type ---
await p.click('[data-section="orders"]');
await p.waitForSelector('#fservice', { timeout: 8000 });
check('filtre service sur les commandes', await p.locator('#fservice').isVisible());
await p.selectOption('#fservice', 'preorder');
await p.click('#applyFilters');
await p.waitForTimeout(1200);
const orderRows = await p.locator('tbody tr').allInnerTexts();
check('commandes filtrees en precommande',
  orderRows.length === 0 || orderRows.every((r) => /Précommande/i.test(r)),
  orderRows.join(' | ').slice(0, 150));

// --- put it back to immediate ---
await p.click('[data-section="restaurants"]');
await p.waitForSelector('#fQ', { timeout: 8000 });
await p.fill('#fQ', 'Le Grill Royal');
await p.waitForTimeout(900);
await p.locator('[data-open]').first().click();
await p.waitForSelector('#aSvcSwitch', { timeout: 8000 });
await p.click('[data-asvc="immediate"]');
await p.waitForTimeout(300);
await p.click('#saveService');
await p.waitForTimeout(1600);
check('retour en immediat', (await p.locator('#content').innerText()).includes('immédiate'));

console.log('ERREURS:', errs.length ? errs.slice(0, 6) : 'aucune');
if (errs.length) fail += errs.length;
console.log(`\n  ${pass} verifications reussies, ${fail} echecs\n`);
await b.close();
process.exit(fail ? 1 : 0);
})();
