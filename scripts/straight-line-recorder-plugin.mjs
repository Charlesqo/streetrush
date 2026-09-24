import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Local development only: accept a same-origin diagnostic report, never a path.
export function straightLineRecorderPlugin(projectRoot) {
  return {
    name: 'streetrush-straight-line-recorder',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__streetrush/straight-line-recording', (req, res) => {
        const host = req.headers.host ?? '';
        if (req.method !== 'POST' || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)
          || req.headers.origin !== `http://${host}`) {
          res.writeHead(403).end('Local same-origin POST required');
          return;
        }
        let size = 0;
        const chunks = [];
        req.on('data', (chunk) => {
          size += chunk.length;
        if (size > 128 * 1024 * 1024) {
          res.writeHead(413).end('Recording exceeds 128 MiB');
            req.destroy();
          } else chunks.push(chunk);
        });
        req.on('end', async () => {
          try {
            const text = Buffer.concat(chunks).toString('utf8');
            const data = JSON.parse(text);
            if (data.schema !== 'streetrush.straight-line-recording.v1'
              || !/^[a-f0-9-]{36}$/.test(data.runId)
              || !Array.isArray(data.samples) || data.samples.length > 20000) {
              res.writeHead(400).end('Invalid diagnostic recording');
              return;
            }
            const relativePath = `docs/verification/straight-line/${data.runId}.json`;
            await mkdir(join(projectRoot, 'docs/verification/straight-line'), { recursive: true });
            await writeFile(join(projectRoot, relativePath), `${text}\n`, { flag: 'wx' });
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ path: relativePath, samples: data.samples.length, bytes: size }));
          } catch (error) {
            res.writeHead(error.code === 'EEXIST' ? 409 : 500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
          }
        });
      });
    },
  };
}
