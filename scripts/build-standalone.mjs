// Standalone build: a single index.html that works when opened straight
// from disk (double-click), with no server. Browsers refuse to load module
// scripts from file:// URLs, so every script and stylesheet is inlined.
//
// The Content-Security-Policy stays strict: instead of allowing all inline
// code, it allows exactly these inlined blocks by their SHA-256 hash.
//
// Output: dist-standalone/index.html (+ THIRD_PARTY_NOTICES.txt).
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'vite';

const OUT = 'dist-standalone';
process.env.BASE_PATH = './';
process.env.OUT_DIR = OUT;
await build({ logLevel: 'warn' });

let html = await readFile(join(OUT, 'index.html'), 'utf8');
const hash = (s) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;
const scriptHashes = [];
const styleHashes = [];

// <script ... src="./x.js"></script> -> inline. Escape "</script" inside code.
async function inlineScript(tagRe, type) {
  const m = html.match(tagRe);
  if (!m) throw new Error(`standalone build: script not found: ${tagRe}`);
  const code = (await readFile(join(OUT, m[1]), 'utf8'))
    .replace(/\n?\/\/# sourceMappingURL=\S+\s*$/, '') // the .map files aren't shipped
    .replace(/<\/script/gi, '<\\/script');
  scriptHashes.push(hash(code));
  html = html.replace(m[0], () => `<script${type ? ` type="${type}"` : ''}>${code}</script>`);
}
await inlineScript(/<script src="\.\/(theme-init\.js)"><\/script>/, '');
await inlineScript(/<script type="module" crossorigin src="\.\/(assets\/index-[^"]+\.js)"><\/script>/, 'module');

const css = html.match(/<link rel="stylesheet" crossorigin href="\.\/(assets\/index-[^"]+\.css)">/);
if (!css) throw new Error('standalone build: stylesheet not found');
const styles = await readFile(join(OUT, css[1]), 'utf8');
styleHashes.push(hash(styles));
html = html.replace(css[0], () => `<style>${styles}</style>`);

// Allow exactly the inlined blocks; keep every other directive unchanged.
html = html
  .replace("script-src 'self' 'wasm-unsafe-eval'", `script-src 'self' ${scriptHashes.join(' ')}`)
  .replace("style-src 'self'", `style-src 'self' ${styleHashes.join(' ')}`);
if (!html.includes(scriptHashes[0]) || !html.includes(styleHashes[0])) throw new Error('standalone build: CSP not updated');

await writeFile(join(OUT, 'index.html'), html);
// Everything else is now inside index.html (the lazily loaded WASM encoder
// can't run from disk and isn't offered there).
await rm(join(OUT, 'assets'), { recursive: true, force: true });
await rm(join(OUT, 'theme-init.js'), { force: true });
const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`Standalone build: ${OUT}/index.html (${kb} KB) — open it directly in a browser.`);
