const { chromium } = require('playwright');
let pass = 0, fail = 0;
const check = (l, ok, extra='') => { ok ? (pass++, console.log('  ok   '+l)) : (fail++, console.log('  FAIL '+l+' '+extra)); };
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1300, height: 1000 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  await p.goto('http://localhost:3000/admin.html', { waitUntil: 'networkidle' });
  await p.fill('#email', 'admin@demo.ma'); await p.fill('#pass', 'admin1234'); await p.click('#btn');
  await p.waitForTimeout(1600);

  const sections = await p.locator('[data-section]').evaluateAll((nodes) => nodes.map((n) => n.dataset.section));
  check('toutes les sections listees', sections.length === 15, sections.join(','));

  for (const key of sections) {
    await p.click(`[data-section=${key}]`);
    await p.waitForTimeout(1300);
    const text = (await p.locator('#content').textContent()).trim();
    const broken = /is not defined|undefined is not|Cannot read|NaN|\[object Object\]|Erreur interne/.test(text);
    const empty = text.length < 12;
    check(`section "${key}" s affiche`, !broken && !empty, broken ? text.slice(0, 90) : `len=${text.length}`);
  }

  // same sweep in Arabic
  await p.click('#langBtn');
  await p.waitForTimeout(1400);
  for (const key of sections) {
    await p.click(`[data-section=${key}]`);
    await p.waitForTimeout(1100);
    const text = (await p.locator('#content').textContent()).trim();
    const broken = /is not defined|Cannot read|\[object Object\]/.test(text);
    check(`section "${key}" en arabe`, !broken && text.length > 10, broken ? text.slice(0, 80) : `len=${text.length}`);
  }

  console.log('ERREURS:', errs.length ? errs.slice(0, 6) : 'aucune');
  console.log(`\n  ${pass} verifications reussies, ${fail} echecs\n`);
  await b.close();
  process.exit(fail || errs.length ? 1 : 0);
})();
