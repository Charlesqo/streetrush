import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// An isolated dev server injects diagnostics only. Production files are untouched.
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  publicDir: 'public',
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
  plugins: [{
    name: 'porsche-audit-only', enforce: 'pre',
    transform(code, id) {
      if (!id.replaceAll('\\', '/').endsWith('/src/render-review.js')) return;
      const needle = '  return { get measuring()';
      if (!code.includes(needle)) throw new Error('Review hook changed; audit injection refused');
      return code.replace(needle, `  if (params.has('porscheaudit')) {
    const { installPorscheAudit } = await import('/research-output/porsche-render-fix-20260920/audit-controls.js');
    await installPorscheAudit({ renderer, camera, scene, renderPipeline, lighting, getVehicle, setView: value => { view = value; } });
  }
${needle}`);
    },
  }],
});

