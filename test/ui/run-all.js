/* Runs every browser suite in turn and prints a tally. */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
  .filter((f) => f.endsWith('.js') && f !== 'run-all.js' && !f.startsWith('_'))
  .sort();

let pass = 0, fail = 0;
for (const file of files) {
  let output = '';
  try { output = execFileSync('node', [join(here, file)], { encoding: 'utf8' }); }
  catch (err) { output = `${err.stdout || ''}${err.stderr || ''}`; }
  const match = output.match(/(\d+) verifications reussies, (\d+) echecs/);
  const ok = match ? Number(match[1]) : 0;
  const ko = match ? Number(match[2]) : 1;
  pass += ok; fail += ko;
  console.log(`${file.padEnd(20)} ${match ? `${ok} ok, ${ko} echecs` : 'PAS DE RESULTAT'}`);
}
console.log(`\n  ${pass} verifications reussies, ${fail} echecs\n`);
process.exit(fail ? 1 : 0);
