import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const modeArgument = process.argv.find((argument) => argument.startsWith('--mode='));
const mode = modeArgument?.slice('--mode='.length) ?? 'inventory';
const validModes = new Set(['inventory', 'public', 'commercial']);

if (!validModes.has(mode)) {
  console.error(`Unknown mode "${mode}". Use inventory, public, or commercial.`);
  process.exit(2);
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile()) files.push(relative(projectRoot, path));
  }
  return files;
}

const manifestPath = join(projectRoot, 'licenses', 'assets.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const entries = manifest.assets ?? [];
const trackedRoots = ['public/cars', 'public/textures', 'source-models'];
const actualPaths = (await Promise.all(trackedRoots.map((root) => walk(join(projectRoot, root))))).flat().sort();
const manifestPaths = entries.map((entry) => entry.path).sort();
const errors = [];

if (new Set(manifestPaths).size !== manifestPaths.length) errors.push('manifest contains duplicate paths');
for (const path of actualPaths) {
  if (!manifestPaths.includes(path)) errors.push(`${path}: missing from licenses/assets.json`);
}
for (const path of manifestPaths) {
  if (!actualPaths.includes(path)) errors.push(`${path}: manifest entry has no matching file`);
}

for (const entry of entries) {
  if (!/^[a-f0-9]{64}$/.test(entry.sha256 ?? '')) {
    errors.push(`${entry.path}: invalid SHA-256`);
    continue;
  }
  try {
    const digest = createHash('sha256').update(await readFile(join(projectRoot, entry.path))).digest('hex');
    if (digest !== entry.sha256) errors.push(`${entry.path}: SHA-256 changed; review the replacement and update the ledger`);
  } catch {
    // Missing paths were already reported above.
  }
}

const notice = await readFile(join(projectRoot, 'public', 'THIRD_PARTY_NOTICES.txt'), 'utf8');
const indexHtml = await readFile(join(projectRoot, 'index.html'), 'utf8');
const noticeLinked = /href=["'][^"']*THIRD_PARTY_NOTICES\.txt["']/.test(indexHtml);
const attributedSources = new Set(
  entries
    .filter((entry) => entry.shipped && entry.attributionRequired && entry.source)
    .map((entry) => entry.source),
);
for (const source of attributedSources) {
  if (!notice.includes(source)) errors.push(`THIRD_PARTY_NOTICES.txt is missing attribution source ${source}`);
}

const shipped = entries.filter((entry) => entry.shipped);
const publicBlockers = shipped.filter((entry) => entry.publicDistribution !== 'allowed');
const commercialBlockers = shipped.filter(
  (entry) => entry.publicDistribution !== 'allowed' || entry.commercialUse !== 'allowed',
);
const policyBlockers = mode === 'public' ? publicBlockers : mode === 'commercial' ? commercialBlockers : [];

if (mode !== 'inventory' && !noticeLinked) {
  errors.push('index.html has no discoverable link to THIRD_PARTY_NOTICES.txt');
}

if (policyBlockers.length) {
  for (const entry of policyBlockers) {
    errors.push(
      `${entry.path}: ${mode} release blocked (${entry.license}; `
      + `distribution=${entry.publicDistribution}, commercial=${entry.commercialUse})`,
    );
  }
}

if (errors.length) {
  for (const error of errors) console.error(`BLOCK ${error}`);
  console.error(`Asset license check failed in ${mode} mode with ${errors.length} finding(s).`);
  process.exitCode = 1;
} else {
  console.log(
    `PASS asset inventory ${entries.length} files; `
    + `public blockers=${publicBlockers.length}, commercial blockers=${commercialBlockers.length}; `
    + `notice linked=${noticeLinked}; mode=${mode}`,
  );
}
