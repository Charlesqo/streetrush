import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'dist');
const target = join(root, 'pages-dist');
const excluded = new Set(['build-provenance.json', 'validation.html']);

for (const name of ['index.html', '404.html', 'robots.txt', 'sitemap.xml', 'social-preview.jpg']) {
  if (!(await stat(join(source, name))).isFile()) throw new Error(`Missing build output: ${name}`);
}

const sourceFiles = await readdir(source, { recursive: true });
if (sourceFiles.some((name) => name === 'validation.html' || /^assets\/validation-[^/]+\.js$/.test(name))) {
  throw new Error('Vehicle Lab entered dist/. Remove its Vite input before packaging.');
}

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, {
  recursive: true,
  filter: (path) => !excluded.has(relative(source, path)),
});

const packaged = await readdir(target, { recursive: true });
if (packaged.some((name) => excluded.has(name) || /^assets\/validation-[^/]+\.js$/.test(name))) {
  throw new Error('A test page or build source manifest entered pages-dist/.');
}
console.log(`Cloudflare Pages production package ready: pages-dist/ (${packaged.length} entries)`);
