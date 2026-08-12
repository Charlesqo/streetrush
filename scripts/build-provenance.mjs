import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

export const BUILD_PROVENANCE_FILE = 'build-provenance.json';

const buildInputFiles = [
  'index.html',
  'validation.html',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'vite.config.js',
  'scripts/build-provenance.mjs',
];

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

export async function getBuildInputPaths(projectRoot) {
  const paths = [];
  for (const relativePath of buildInputFiles) {
    const path = join(projectRoot, relativePath);
    try {
      if ((await stat(path)).isFile()) paths.push(path);
    } catch {
      // Optional package-manager metadata may be absent in a deployment checkout.
    }
  }
  for (const directory of ['src', 'public']) {
    const path = join(projectRoot, directory);
    try {
      paths.push(...await walk(path));
    } catch {
      // The caller separately reports a missing public directory.
    }
  }
  return paths.sort();
}

export async function createInputManifest(projectRoot) {
  const paths = await getBuildInputPaths(projectRoot);
  return Promise.all(paths.map(async (path) => ({
    path: relative(projectRoot, path),
    sha256: await sha256(path),
  })));
}

export function getGitCommit(projectRoot) {
  try {
    return execFileSync('git', ['-C', projectRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

export async function createBuildProvenance(projectRoot) {
  return {
    schema: 1,
    gitCommit: getGitCommit(projectRoot),
    inputs: await createInputManifest(projectRoot),
  };
}
