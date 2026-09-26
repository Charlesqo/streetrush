import { createServer } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../../', import.meta.url));
const outputRoot = path.join(root, 'research-output/live-driving');
fs.mkdirSync(outputRoot, { recursive: true });
const manifest = {};
const binaryAssets = new Map();
function listAssets(dir) {
  for (const entry of fs.readdirSync(path.join(root, 'public', dir), { withFileTypes: true })) {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) listAssets(relative);
    else if (/\.(wav|bin|glb|hdr)$/i.test(entry.name)) binaryAssets.set(`/${relative.replaceAll('\\', '/')}`, path.join(root, 'public', relative));
  }
}
listAssets('');
function hashSources(dir) {
  for (const item of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const relative = path.join(dir, item.name);
    if (item.isDirectory()) hashSources(relative);
    else if (item.name.endsWith('.js')) manifest[relative] = createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex');
  }
}
hashSources('src');
manifest['index.html'] = createHash('sha256').update(fs.readFileSync(path.join(root, 'index.html'))).digest('hex');
const plugin = {
  name: 'temporary-last-five-seconds',
  transformIndexHtml: { order: 'pre', handler(html) {
    const original = "import('/src/main.js')";
    if (!html.includes(original)) throw new Error('Normal game boot entry changed; refusing to replace anything else.');
    return html.replace(original, "import('/scratch/live-driving-recorder/bootstrap.js')");
  } },
  configureServer(server) {
    server.middlewares.use('/__live-recorder/asset', (req, res) => {
      try {
        const key = new URL(req.url, 'http://localhost').searchParams.get('key');
        const asset = key && binaryAssets.get(Buffer.from(key, 'base64url').toString('utf8'));
        if (req.method !== 'GET' || !asset) { res.writeHead(404).end(); return; }
        // This is a fetch-only transport, never a navigable media/download link.
        // MIME does not alter response.arrayBuffer(); don't send a filename header.
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': fs.statSync(asset).size,
          'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=3600' });
        fs.createReadStream(asset).pipe(res);
      } catch { res.writeHead(400).end(); }
    });
    server.middlewares.use('/__live-recorder/save', (req, res) => {
      const host = req.headers.host ?? '';
      if (req.method !== 'POST' || !/^(127\.0\.0\.1|localhost):5192$/.test(host) || req.headers.origin !== `http://${host}`) {
        res.writeHead(403).end(); return;
      }
      const chunks = []; let size = 0;
      req.on('data', chunk => {
        size += chunk.length;
        if (size > 64 * 1024 * 1024) { res.writeHead(413).end(); req.destroy(); }
        else chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (data.schema !== 'streetrush.last-five-seconds.v1' || !Array.isArray(data.samples)
            || data.samples.length > 2048 || !/^[a-f0-9-]{36}$/.test(data.runId)) throw new Error('Invalid recording');
          data.sourceSha256AtServerStart = manifest;
          data.sourceUnchangedAtSave = Object.entries(manifest).every(([name, hash]) =>
            createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex') === hash);
          const name = `${data.createdAt.replace(/[^0-9TZ-]/g, '-')}-${data.runId}.json`;
          const destination = path.join(outputRoot, name);
          fs.writeFileSync(destination, JSON.stringify(data) + '\n', { flag: 'wx' });
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ path: destination, samples: data.samples.length }));
          console.log(JSON.stringify({ saved: destination, samples: data.samples.length, car: data.vehicleConfig.id }));
        } catch (error) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
      });
    });
  },
};
const server = await createServer({ root, plugins: [plugin], server: { host: '127.0.0.1', port: 5192, strictPort: true } });
await server.listen(); server.printUrls();
