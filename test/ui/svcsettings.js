/* Restaurant side: switch between immediate and pre-order and save the rules. */
const { chromium } = require('playwright');
const { dismissAddressGate } = require('./_shared.js');
let pass = 0, fail = 0;
const check = (l, ok, extra='') => { ok ? (pass++, console.log('  ok   '+l)) : (fail++, console.log('  FAIL '+l+' '+extra)); };

(async () => {
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1200, height: 900 } });
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

await p.goto('http://localhost:3000/restaurant.html', { waitUntil: 'networkidle' });
// Bella Napoli's owner: an immediate restaurant to start from.
await p.fill('#liId', '0611000001');
await p.fill('#liPass', 'resto1234');
await p.click('#liBtn');
await p.waitForSelector('[data-tab]', { timeout: 10000 });
check('espace restaurant ouvert', await p.locator('[data-tab="settings"]').isVisible());
check('badge de service affiche', await p.locator('.badge.immediate, .badge.preorder').count() > 0);

await p.click('[data-tab="settings"]');
await p.waitForSelector('#svcSwitch', { timeout: 8000 });
check('choix du type de service present', await p.locator('[data-svc="immediate"]').isVisible());
check('immediat actif au depart', (await p.locator('[data-svc="immediate"]').getAttribute('class')).includes('active'));
check('config precommande masquee', await p.locator('#svcConfig').evaluate((el) => el.classList.contains('hidden')));

// --- switch to pre-order ---
await p.click('[data-svc="preorder"]');
await p.waitForTimeout(400);
check('config precommande visible', !(await p.locator('#svcConfig').evaluate((el) => el.classList.contains('hidden'))));

// saving with no slot must be refused by the interface
await p.fill('#sSlots', '');
await p.click('#saveService');
await p.waitForTimeout(700);
check('refus si aucun creneau', await p.locator('.toast').count() > 0);
await p.waitForTimeout(2600);

// now a valid configuration
await p.selectOption('#sPrepHours', '48');
await p.locator('[data-daychip="2"]').click();
await p.locator('[data-daychip="5"]').click();
await p.fill('#sSlots', '11:00-13:00\n18:00-20:00');
await p.fill('#sCutoff', '17:00');
await p.click('#saveService');
await p.waitForTimeout(1800);

check('badge passe en precommande', await p.locator('.badge.preorder').count() > 0);
const headerText = await p.locator('.card').first().innerText();
check('entete montre 48h', headerText.includes('48'), headerText.slice(0, 80));

// reload and confirm it was persisted
await p.reload({ waitUntil: 'networkidle' });
await p.waitForSelector('[data-tab]', { timeout: 10000 });
await p.click('[data-tab="settings"]');
await p.waitForSelector('#svcSwitch', { timeout: 8000 });
check('precommande conservee apres rechargement',
  (await p.locator('[data-svc="preorder"]').getAttribute('class')).includes('active'));
check('delai conserve', await p.locator('#sPrepHours').inputValue() === '48');
check('creneaux conserves', (await p.locator('#sSlots').inputValue()).includes('11:00-13:00'));
check('heure limite conservee', await p.locator('#sCutoff').inputValue() === '17:00');
const mardi = await p.locator('[data-daychip="2"]').getAttribute('class');
check('jours conserves', mardi.includes('active'), mardi);

// the customer side must now show it as a pre-order restaurant
const c = await b.newPage();
await c.goto('http://localhost:3000/?x=1', { waitUntil: 'networkidle' });
await dismissAddressGate(c);
await c.waitForSelector('.resto-card', { timeout: 10000 });
await c.click('[data-service="preorder"]');
await c.waitForTimeout(800);
const preorderNames = await c.locator('.resto-card h3').allInnerTexts();
check('visible cote client en precommande', preorderNames.some((n) => n.includes('Bella Napoli')), preorderNames.join(','));

// --- back to immediate ---
await p.click('[data-svc="immediate"]');
await p.waitForTimeout(300);
await p.click('#saveService');
await p.waitForTimeout(1600);
check('retour en immediat', await p.locator('.badge.immediate').count() > 0);

console.log('ERREURS:', errs.length ? errs.slice(0, 6) : 'aucune');
if (errs.length) fail += errs.length;
console.log(`\n  ${pass} verifications reussies, ${fail} echecs\n`);
await b.close();
process.exit(fail ? 1 : 0);
})();
