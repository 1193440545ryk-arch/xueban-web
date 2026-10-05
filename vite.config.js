import {defineConfig} from 'vite';
import {readFileSync, existsSync, createReadStream, statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const release = JSON.parse(readFileSync(path.join(here, 'public/releases.json'), 'utf8'));
const installer = path.join(here, '..', 'dist', release.localFilename || release.filename);

function desktopPreview(server) {
  server.middlewares.use((req, res, next) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/releases.json' && existsSync(installer)) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({...release, url: './__desktop_download__/' + encodeURIComponent(release.filename)})); return;
    }
    if (pathname === '/__desktop_download__/' + encodeURIComponent(release.filename) && existsSync(installer)) {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="xueban-${release.version}-setup.exe"; filename*=UTF-8''${encodeURIComponent(release.filename)}`);
      res.setHeader('Content-Length', statSync(installer).size);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (req.method === 'HEAD') res.end();
      else if (req.method === 'GET') createReadStream(installer).pipe(res);
      else { res.statusCode = 405; res.end(); }
      return;
    }
    next();
  });
}

export default defineConfig({
  base: './',
  build: {outDir: 'dist-web', target: 'es2022', chunkSizeWarningLimit: 1800},
  worker: {format: 'es'},
  server: {host: '127.0.0.1', port: 4173, strictPort: true},
  preview: {host: '127.0.0.1', port: 4174, strictPort: true},
  plugins: [{name: 'local-desktop-preview', configureServer: desktopPreview}],
});
