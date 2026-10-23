// Minimal static server that mimics GitHub Pages for a project site:
// files are served only under the base path, "/base" redirects to "/base/",
// everything else is 404, and no security headers are added (GitHub Pages
// can't send custom ones, so the CSP must work as a <meta> tag).
// Usage: node scripts/serve-pages.mjs --dir dist-pages --base /OpenConverter/ --port 4180
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, v, i, a) => (v.startsWith('--') ? [...acc, [v.slice(2), a[i + 1]]] : acc), []),
);
const root = resolve(args.dir ?? 'dist-pages');
const base = args.base ?? '/OpenConverter/';
const port = Number(args.port ?? 4180);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = decodeURIComponent(url.pathname);
  if (path === base.slice(0, -1)) {
    res.writeHead(301, { Location: base + url.search }).end();
    return;
  }
  if (!path.startsWith(base)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404 (outside the project path)');
    return;
  }
  let file = normalize(join(root, path.slice(base.length)));
  if (file !== root && !file.startsWith(root + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    await stat(file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404');
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}).listen(port, () => console.log(`Serving ${root} at http://localhost:${port}${base}`));
