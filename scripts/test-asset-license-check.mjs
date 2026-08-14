import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const checker = fileURLToPath(new URL('./check-asset-licenses.mjs', import.meta.url));

const output = execFileSync(
  process.execPath,
  [checker, '--mode=inventory'],
  { encoding: 'utf8' },
);

assert.match(output, /PASS asset inventory 52 files; public blockers=43, commercial blockers=45/);
assert.doesNotMatch(output, /missing from licenses\/assets\.json/);
assert.doesNotMatch(output, /manifest entry has no matching file/);

console.log('PASS asset manifest paths match the filesystem on this platform');
