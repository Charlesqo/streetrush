import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { defineConfig } from 'vite';
import { BUILD_PROVENANCE_FILE, createBuildProvenance } from './scripts/build-provenance.mjs';
import { straightLineRecorderPlugin } from './scripts/straight-line-recorder-plugin.mjs';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

function buildProvenancePlugin() {
  return {
    name: 'street-rush-build-provenance',
    apply: 'build',
    async closeBundle() {
      const outputPath = join(projectRoot, 'dist', BUILD_PROVENANCE_FILE);
      await writeFile(outputPath, `${JSON.stringify(await createBuildProvenance(projectRoot), null, 2)}\n`);
    },
  };
}

export default defineConfig({
  plugins: [buildProvenancePlugin(), straightLineRecorderPlugin(projectRoot)],
  publicDir: 'public',
  server: { host: '127.0.0.1' },
  build: {
    rollupOptions: {
      input: { game: 'index.html' },
    },
  },
});
