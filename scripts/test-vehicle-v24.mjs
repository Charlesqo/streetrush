import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const suites = [
  ['contract', 'test-vehicle-v24-contract.mjs'],
  ['selected-reference-checks', 'test-vehicle-v24-golden.mjs'],
  ['rapier-host', 'test-vehicle-v24-host.mjs'],
  ['runtime', 'test-vehicle-v24-runtime.mjs'],
  ['wheel-spin-reaction', 'test-vehicle-v24-wheel-reaction.mjs'],
  ['playability', 'test-vehicle-v24-playability.mjs'],
  ['forced-downshift', 'test-vehicle-v24-downshift.mjs'],
  ['legacy-isolation', 'test-vehicle-v24-legacy-isolation.mjs'],
  ['determinism', 'test-vehicle-v24-determinism.mjs'],
  ['performance', 'test-vehicle-v24-performance.mjs'],
];

const results = [];
for (const [name, filename] of suites) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(filename, import.meta.url))], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);

  const lines = (result.stdout ?? '').trim().split(/\r?\n/).filter(Boolean);
  let checks = null;
  let status = null;
  let referenceParity = null;
  for (const line of lines) {
    try {
      const payload = JSON.parse(line);
      if (Number.isInteger(payload.checks)) checks = payload.checks;
      if (typeof payload.status === 'string') status = payload.status;
      if (typeof payload.referenceParity === 'string') referenceParity = payload.referenceParity;
    } catch {
      const match = line.match(/\b(PASS|FAIL)\s+\((\d+) checks\)\s*$/);
      if (match) {
        status = match[1];
        checks = Number.parseInt(match[2], 10);
      }
    }
  }
  if (status !== 'PASS' || !Number.isInteger(checks) || checks <= 0) {
    throw new Error(`${name} did not emit a machine-verifiable PASS/check count`);
  }
  results.push({ name, status, checks, ...(referenceParity ? { referenceParity } : {}) });
}

console.log(JSON.stringify({
  schema: 'streetrush.vehicle-v24.gate.v1',
  status: 'PASS',
  scope: 'current-working-tree implementation checks; not v2.4 completeness',
  referenceParity: 'PARTIAL',
  suites: suites.length,
  checks: results.reduce((sum, result) => sum + result.checks, 0),
  results,
}));
