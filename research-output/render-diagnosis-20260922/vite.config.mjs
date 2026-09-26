import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { writeFile, mkdir } from 'node:fs/promises';
const folder = fileURLToPath(new URL('./', import.meta.url));
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  publicDir: 'public', cacheDir: folder + '/.vite',
  server: { host: '127.0.0.1', port: 5191, strictPort: true },
  plugins: [{
    name: 'isolated-render-diagnosis', enforce: 'pre',
    transform(code, id) {
      if (!id.replaceAll('\\', '/').endsWith('/src/main.js')) return;
      const needle = 'function animate(now) {';
      if (!code.includes(needle)) throw new Error('Diagnostic injection point changed');
      return code.replace(needle, 'let diagnosisFrozen = false;\nfunction animate(now) { if (diagnosisFrozen) { requestAnimationFrame(animate); return; }') + `
const { installDiagnosis } = await import('/research-output/render-diagnosis-20260922/controls.js');
installDiagnosis({ THREE, renderer, scene, camera, lighting, renderPipeline, track,
  getVehicle: () => vehicle, getState: () => state,
  freeze: () => { diagnosisFrozen = true; vehicle?.syncVisual(1); input.releaseAll(); setAudioPaused(true); },
  resume: () => { diagnosisFrozen = false; lastFrame = performance.now(); }
});
`;
    },
    configureServer(server) {
      server.middlewares.use('/__diagnosis_save', async (req, res) => {
        try {
          if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
          let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 35000000) throw new Error('Capture too large'); }
          const data = JSON.parse(body);
          if (!/^[a-z0-9_-]+$/.test(data.name)) throw new Error('Invalid capture name');
          if (!data.png.startsWith('data:image/png;base64,')) throw new Error('Invalid image');
          await mkdir(folder + '/frames', { recursive: true });
          await writeFile(folder + '/frames/' + data.name + '.png', Buffer.from(data.png.split(',')[1], 'base64'));
          await writeFile(folder + '/frames/' + data.name + '.json', JSON.stringify(data.state, null, 2));
          res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ saved: data.name }));
        } catch (error) { res.statusCode = 400; res.end(String(error)); }
      });
    },
  }],
});
