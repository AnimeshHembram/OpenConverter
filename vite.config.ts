import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * GitHub Pages serves project sites from /<repository-name>/. CI and
 * `npm run build:pages` set BASE_PATH; a plain `npm run build` targets "/".
 */
const base = process.env.BASE_PATH ?? '/';
// "./" (relative) is used only by the standalone build (scripts/build-standalone.mjs).
if (base !== './' && (!base.startsWith('/') || !base.endsWith('/'))) {
  throw new Error(`BASE_PATH must start and end with "/", got "${base}"`);
}

/** Repository shown in the footer. GitHub Actions sets GITHUB_REPOSITORY. */
const repository = process.env.GITHUB_REPOSITORY ?? 'AnimeshHembram/OpenConverter';
if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error(`Unexpected GITHUB_REPOSITORY: ${repository}`);

/**
 * Content-Security-Policy for the production build. `connect-src 'self'`
 * makes the browser block requests to any other site, which backs up the
 * "files never leave your device" promise (the static host accepts no
 * uploads). GitHub Pages cannot set response headers, so it is delivered as
 * a <meta> tag; `frame-ancestors` and `report-uri` can't be set that way.
 * Not applied in dev, where Vite needs inline scripts and a websocket.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'", // WebAssembly WebP encoder
  "style-src 'self'",
  "img-src 'self' blob: data:", // previews are blob: URLs; the favicon is a data: URL
  "connect-src 'self'", // same-origin only: loads the .wasm encoder
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function htmlPlugin(): Plugin {
  return {
    name: 'openconvert-html',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        let out = html.replaceAll('%OPENCONVERT_REPO_URL%', `https://github.com/${repository}`);
        if (!ctx.server) {
          out = out.replace(
            '<meta charset="UTF-8" />',
            `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
          );
        }
        return out;
      },
    },
  };
}

/**
 * The site redistributes third-party code (the WebP encoder: libwebp under
 * BSD-3-Clause, and two Apache-2.0 packages). Their licences require their
 * notices to accompany the distribution, so the build emits
 * THIRD_PARTY_NOTICES.txt from the installed packages' own licence files.
 */
function thirdPartyNoticesPlugin(): Plugin {
  const require = createRequire(import.meta.url);
  const pkgDir = (name: string) => dirname(require.resolve(`${name}/package.json`));
  const sections = [
    { title: '@jsquash/webp (Apache-2.0) — https://github.com/jamsinclair/jSquash', file: join(pkgDir('@jsquash/webp'), 'LICENSE') },
    { title: 'libwebp, compiled to WebAssembly inside @jsquash/webp (BSD-3-Clause) — https://chromium.googlesource.com/webm/libwebp', file: join(pkgDir('@jsquash/webp'), 'codec', 'LICENSE.codec.md') },
    { title: 'wasm-feature-detect (Apache-2.0) — https://github.com/GoogleChromeLabs/wasm-feature-detect', file: join(pkgDir('wasm-feature-detect'), 'LICENSE') },
    { title: 'marked (MIT) — https://github.com/markedjs/marked', file: join(pkgDir('marked'), 'LICENSE') },
    { title: 'exceljs (MIT) — https://github.com/exceljs/exceljs', file: join(pkgDir('exceljs'), 'LICENSE') },
    // exceljs's browser build bundles these packages:
    { title: 'JSZip, bundled in exceljs (used under MIT; dual-licensed MIT or GPL-3.0) — https://github.com/Stuk/jszip', file: join(pkgDir('jszip'), 'LICENSE.markdown') },
    { title: 'pako, bundled in exceljs (MIT and Zlib) — https://github.com/nodeca/pako', file: join(pkgDir('pako'), 'LICENSE') },
    { title: 'buffer, bundled in exceljs (MIT) — https://github.com/feross/buffer', file: join(pkgDir('buffer'), 'LICENSE') },
    { title: 'dayjs, bundled in exceljs (MIT) — https://github.com/iamkun/dayjs', file: join(pkgDir('dayjs'), 'LICENSE') },
    { title: 'readable-stream, bundled in exceljs (MIT) — https://github.com/nodejs/readable-stream', file: join(pkgDir('readable-stream'), 'LICENSE') },
  ];
  return {
    name: 'openconvert-third-party-notices',
    apply: 'build',
    generateBundle() {
      const body = sections
        .map((s) => `${'='.repeat(78)}\n${s.title}\n${'='.repeat(78)}\n\n${readFileSync(s.file, 'utf8').trim()}\n`)
        .join('\n');
      this.emitFile({
        type: 'asset',
        fileName: 'THIRD_PARTY_NOTICES.txt',
        source: `OpenConverter includes the following third-party software. The exceljs browser build also bundles saxes and xmlchars (ISC, by Louis-Dominique Dubeau) and other small MIT-licensed packages; their notices are kept in the code.\n\n${body}`,
      });
    },
  };
}

export default defineConfig({
  base,
  plugins: [htmlPlugin(), thirdPartyNoticesPlugin()],
  // The WebP WASM encoder must not be pre-bundled, or its .wasm file is lost.
  optimizeDeps: { exclude: ['@jsquash/webp'] },
  build: {
    target: 'es2022',
    sourcemap: true,
    // OUT_DIR lets the subpath build sit beside the root build for testing.
    outDir: process.env.OUT_DIR ?? 'dist',
    emptyOutDir: true,
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
