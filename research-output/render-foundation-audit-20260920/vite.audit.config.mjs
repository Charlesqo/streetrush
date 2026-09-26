import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Observe the normal entry point: no renderreview flag, lighting overrides,
// quality overrides or asset substitutions. Production files stay untouched.
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  publicDir: 'public',
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
  plugins: [{ name: 'foundation-read-only-observer', enforce: 'pre',
    transform(code, id) {
      if (!id.replaceAll('\\', '/').endsWith('/src/main.js')) return;
      return code + `
if (new URLSearchParams(location.search).has('foundationaudit')) {
  const { installObserver } = await import('/research-output/render-foundation-audit-20260920/observer.js');
  installObserver({ renderer, scene, camera, renderPipeline, lighting, getVehicle: () => vehicle, getState: () => state });
}
`;
    },
  }],
});
