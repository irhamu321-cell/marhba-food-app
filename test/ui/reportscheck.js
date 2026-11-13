const { chromium } = require('playwright');
let pass = 0, fail = 0;
const check = (l, ok, extra='') => { ok ? (pass++, console.log('  ok   '+l)) : (fail++, console.log('  FAIL '+l+' '+extra)); };
(async () => {
  const b = await chromium.launch({ downloadsPath: '/tmp/dl' });
  const p = await b.newPage({ viewport: { width: 1250, height: 1200 }, acceptDownloads: true });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

  await p.goto('http://localhost:3000/admin.html', { waitUntil: 'networkidle' });
  await p.fill('#email', 'admin@demo.ma'); await p.fill('#pass', 'admin1234'); await p.click('#btn');
  await p.waitForTimeout(1500);
  await p.click('[data-section=reports]');
  await p.waitForTimeout(1600);

  const text = await p.locator('#content').textContent();
  check('page rapports', text.includes('Ventes par restaurant'));
  check('indicateurs affiches', (await p.locator('.stat').count()) >= 11, String(await p.locator('.stat').count()));
  check('ventes par produit', text.includes('Ventes par produit'));
  check('bloc clients', text.includes('Nouveaux') && text.includes('Fidèles'));
  check('resume caisse', text.includes('de la caisse'));
  check('boutons CSV', (await p.locator('[data-csv]').count()) === 5, String(await p.locator('[data-csv]').count()));
  await p.screenshot({ path: '/tmp/z-reports.png', fullPage: true });

  // date range buttons
  await p.click('#rToday');
  await p.waitForTimeout(1400);
  check('filtre aujourd hui', (await p.locator('#rFrom').inputValue()) === (await p.locator('#rTo').inputValue()));
  await p.click('#rMonth');
  await p.waitForTimeout(1400);
  check('filtre ce mois', (await p.locator('#rFrom').inputValue()).endsWith('-01'));

  // CSV download
  const [download] = await Promise.all([
    p.waitForEvent('download', { timeout: 15000 }),
    p.locator('[data-csv="restaurants"]').click(),
  ]);
  const path = await download.path();
  const fs = require('fs');
  const content = fs.readFileSync(path, 'utf8');
  check('fichier CSV telecharge', download.suggestedFilename().endsWith('.csv'), download.suggestedFilename());
  check('CSV contient les entetes', content.includes('name') && content.includes('commission_cents'),
    content.slice(0, 80).replace(/\n/g, '|'));
  check('CSV contient des lignes', content.split('\n').length >= 2, String(content.split('\n').length));

  console.log('ERREURS:', errs.length ? errs.slice(0, 4) : 'aucune');
  console.log(`\n  ${pass} verifications reussies, ${fail} echecs\n`);
  await b.close();
  process.exit(fail || errs.length ? 1 : 0);
})();
