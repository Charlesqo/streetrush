import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Audit-only instrumentation. Production sources and render settings are unchanged.
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  publicDir: 'public',
  server: { host: '127.0.0.1', port: 5187, strictPort: true },
  plugins: [{ name: 'bidirectional-audit', enforce: 'pre', transform(code, id) {
    if (!id.replaceAll('\\', '/').endsWith('/src/main.js')) return;
    const instrumented = code.replace('function animate(now) {', 'function animate(now) { if (window.__bidirectionalAudit?.frozen) { requestAnimationFrame(animate); return; }');
    return instrumented + `
const auditDraw = renderPipeline.render.bind(renderPipeline);
let auditFrozen = false;
renderPipeline.render = () => auditFrozen ? false : auditDraw();
window.__bidirectionalAudit = {
  THREE, renderer, scene, camera, lighting, renderPipeline, assets, track,
  get vehicle() { return vehicle; }, get state() { return state; },
  get frozen() { return auditFrozen; },
  async mount(id) { state = 'menu'; const result = await mountVehicle(CARS.findIndex(c => c.id === id), true); vehicle?.syncVisual(1); return result; },
  freeze() { state = 'paused'; vehicle?.syncVisual(1); auditFrozen = true; },
  draw() { lighting.update(vehicle.visual, performance.now() + 100); auditDraw(); return canvas.toDataURL('image/png'); },
};
`;
  } }],
});
