/* Run every suite in sequence and summarise. Some talk to the live feature
   service, so they are deliberately not parallel. */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { HERE } from './env-lite.mjs';

const ORDER = [
  'heading', 'layers', 'e2e', 'resilience', 'edit-server', // node, no browser
  'ui', 'ios', 'land', 'camera', 'import', 'roundtrip',    // browser
  'migrate', 'coldoffline', 'tag', 'edit-ui', 'snake',
];
const only = process.argv.slice(2);
const suites = only.length ? only : ORDER;

const run = (name) => new Promise((res) => {
  const p = spawn(process.execPath, [path.join(HERE, name + '.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.on('close', (code) => res({ name, code, out }));
});

let failed = 0;
for (const name of suites) {
  const r = await run(name);
  const last = r.out.trim().split('\n').filter(Boolean).pop() || '';
  console.log(`${r.code === 0 ? 'ok  ' : 'FAIL'} ${name.padEnd(13)} ${last.slice(0, 70)}`);
  if (r.code !== 0) {
    failed++;
    console.log(r.out.split('\n').filter(l => /FAIL|Error/.test(l)).slice(0, 6).map(l => '       ' + l).join('\n'));
  }
}
console.log(failed ? `\n${failed} suite(s) failed` : `\nall ${suites.length} suites passed`);
process.exit(failed ? 1 : 0);
