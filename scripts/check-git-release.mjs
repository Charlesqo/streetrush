import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const projectRoot = realpathSync(fileURLToPath(new URL('../', import.meta.url)));

function git(...arguments_) {
  return execFileSync('git', arguments_, { cwd: projectRoot, encoding: 'utf8' }).trim();
}

let failed = false;
let gitRoot;

try {
  gitRoot = realpathSync(git('rev-parse', '--show-toplevel'));
} catch {
  console.error('BLOCK this directory is not an initialized Git repository');
  process.exit(1);
}

if (gitRoot !== projectRoot) {
  console.error(`BLOCK wrong Git root: expected ${projectRoot}, got ${gitRoot}`);
  failed = true;
}

try {
  git('rev-parse', '--verify', 'HEAD');
} catch {
  console.error('BLOCK repository has no commit baseline');
  failed = true;
}

const status = git('status', '--porcelain=v1', '--untracked-files=all');
if (status) {
  const paths = status.split('\n').slice(0, 20);
  for (const path of paths) console.error(`BLOCK dirty worktree: ${path}`);
  if (status.split('\n').length > paths.length) console.error('BLOCK additional dirty paths omitted');
  failed = true;
}

if (failed) {
  process.exitCode = 1;
} else {
  const head = git('rev-parse', '--short=12', 'HEAD');
  const branch = git('branch', '--show-current') || '(detached)';
  console.log(`PASS release Git state branch=${branch} commit=${head} clean=true`);
}
