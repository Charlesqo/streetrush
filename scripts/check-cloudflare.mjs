import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD_PROVENANCE_FILE, createInputManifest, getGitCommit } from './build-provenance.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const distRoot = join(projectRoot, 'dist');
const publicRoot = join(projectRoot, 'public');
const maxFileBytes = 25 * 1024 * 1024;
const maxFiles = 20_000;

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function requireDirectory(directory, label) {
  try {
    if (!(await stat(directory)).isDirectory()) throw new Error('not a directory');
  } catch {
    console.error(`${label} is missing. Run "pnpm build" before this check.`);
    process.exit(1);
  }
}

await requireDirectory(distRoot, 'dist/');

const distPaths = await walk(distRoot);
if (!distPaths.length) {
  console.error('dist/ is empty. Run "pnpm build" before this check.');
  process.exit(1);
}

const files = await Promise.all(distPaths.map(async (path) => ({ path, size: (await stat(path)).size })));
const oversized = files.filter((file) => file.size > maxFileBytes);
let failed = false;

if (files.length > maxFiles) {
  console.error(`Cloudflare Pages file count exceeded: ${files.length} > ${maxFiles}`);
  failed = true;
}
for (const file of oversized) {
  console.error(`Cloudflare Pages file too large: ${relative(distRoot, file.path)} (${(file.size / 1048576).toFixed(2)} MiB)`);
  failed = true;
}

const distIndex = join(distRoot, 'index.html');

try {
  await stat(distIndex);
} catch {
  console.error('dist/index.html is missing. Run "pnpm build".');
  failed = true;
}

const provenancePath = join(distRoot, BUILD_PROVENANCE_FILE);
try {
  const provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
  const currentCommit = getGitCommit(projectRoot);
  const currentInputs = await createInputManifest(projectRoot);
  if (provenance.schema !== 1 || provenance.gitCommit !== currentCommit) {
    console.error(`Build provenance does not match Git commit ${currentCommit}. Run "pnpm build".`);
    failed = true;
  }
  if (JSON.stringify(provenance.inputs) !== JSON.stringify(currentInputs)) {
    console.error('Build provenance does not match current source inputs. Run "pnpm build".');
    failed = true;
  }
} catch {
  console.error(`dist/${BUILD_PROVENANCE_FILE} is missing or invalid. Run "pnpm build".`);
  failed = true;
}

const publicPaths = await walk(publicRoot);
for (const sourcePath of publicPaths) {
  const relativePath = relative(publicRoot, sourcePath);
  const outputPath = join(distRoot, relativePath);
  try {
    const [sourceHash, outputHash] = await Promise.all([sha256(sourcePath), sha256(outputPath)]);
    if (sourceHash !== outputHash) {
      console.error(`Build is stale: dist/${relativePath} does not match public/${relativePath}. Run "pnpm build".`);
      failed = true;
    }
  } catch {
    console.error(`Build is incomplete: dist/${relativePath} is missing. Run "pnpm build".`);
    failed = true;
  }
}

if (failed) {
  process.exitCode = 1;
} else {
  const total = files.reduce((sum, file) => sum + file.size, 0);
  const largest = files.reduce((current, file) => (file.size > current.size ? file : current));
  console.log(
    `PASS ${files.length} files, ${(total / 1048576).toFixed(2)} MiB total, `
    + `largest ${(largest.size / 1048576).toFixed(2)} MiB; build freshness and public assets verified`,
  );
}
