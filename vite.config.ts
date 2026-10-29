import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
  "worker-src 'self'", // pdf.js parses PDFs in a same-origin worker
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
 * Background removal for photos uses Google's MediaPipe selfie segmentation
 * model (Apache-2.0), served from this site under assets/models/ and only
 * downloaded when a photo needs it. Only the model file is shipped: it runs
 * on OpenConverter's own interpreter, not MediaPipe's WebAssembly runtime.
 */
function segmentationModelPlugin(): Plugin {
  const require = createRequire(import.meta.url);
  const file = join(dirname(require.resolve('@mediapipe/selfie_segmentation/package.json')), 'selfie_segmentation.tflite');
  return {
    name: 'openconvert-segmentation-model',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!/\/assets\/models\/selfie_segmentation\.tflite$/.test(req.url?.split('?')[0] ?? '')) return next();
        res.setHeader('Content-Type', 'application/octet-stream');
        res.end(readFileSync(file));
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'assets/models/selfie_segmentation.tflite', source: readFileSync(file) });
    },
  };
}

/**
 * The site redistributes third-party code (the WebP encoder: libwebp under
 * BSD-3-Clause, and two Apache-2.0 packages). Their licences require their
 * notices to accompany the distribution, so the build emits
 * THIRD_PARTY_NOTICES.txt from the installed packages' own licence files.
 */
/**
 * pdf.js loads data files on demand: character maps (CJK text), the 14
 * standard PDF fonts, ICC colour profiles and WebAssembly image decoders
 * (JPEG 2000, JBIG2, colour management). They're served from this site
 * under assets/pdfjs/ (connect-src 'self'), never from a CDN. The scripting
 * sandbox (quickjs) isn't shipped: PDF JavaScript is never run.
 */
const PDFJS_ASSET_DIRS = ['cmaps', 'standard_fonts', 'iccs', 'wasm'] as const;
const PDFJS_SKIP = /^quickjs|^LICENSE/;

function pdfjsAssetsPlugin(): Plugin {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve('pdfjs-dist/package.json'));
  return {
    name: 'openconvert-pdfjs-assets',
    configureServer(server) {
      // Dev server: serve the same paths straight from node_modules.
      server.middlewares.use((req, res, next) => {
        const m = /\/assets\/pdfjs\/(cmaps|standard_fonts|iccs|wasm)\/([\w.-]+)$/.exec(req.url?.split('?')[0] ?? '');
        if (!m || PDFJS_SKIP.test(m[2]!)) return next();
        try {
          const body = readFileSync(join(root, m[1]!, m[2]!));
          res.setHeader('Content-Type', m[2]!.endsWith('.wasm') ? 'application/wasm' : m[2]!.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
          res.end(body);
        } catch {
          next();
        }
      });
    },
    generateBundle() {
      for (const dir of PDFJS_ASSET_DIRS) {
        for (const name of readdirSync(join(root, dir))) {
          if (PDFJS_SKIP.test(name)) continue;
          this.emitFile({ type: 'asset', fileName: `assets/pdfjs/${dir}/${name}`, source: readFileSync(join(root, dir, name)) });
        }
      }
    },
  };
}

function thirdPartyNoticesPlugin(): Plugin {
  const require = createRequire(import.meta.url);
  // Some packages don't export their package.json; then look in node_modules directly.
  const pkgDir = (name: string) => {
    try {
      return dirname(require.resolve(`${name}/package.json`));
    } catch {
      for (const base of require.resolve.paths(name) ?? []) if (existsSync(join(base, name, 'package.json'))) return join(base, name);
      throw new Error(`third-party notices: package not found: ${name}`);
    }
  };
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
    // PDF reading: pdf.js and the data files it loads from this site.
    { title: 'PDF.js (Apache-2.0) — https://github.com/mozilla/pdf.js', file: join(pkgDir('pdfjs-dist'), 'LICENSE') },
    { title: 'Adobe CMaps, served with PDF.js (BSD-3-Clause)', file: join(pkgDir('pdfjs-dist'), 'cmaps', 'LICENSE') },
    { title: 'Foxit standard fonts, served with PDF.js (BSD-3-Clause, PDFium)', file: join(pkgDir('pdfjs-dist'), 'standard_fonts', 'LICENSE_FOXIT') },
    { title: 'Liberation fonts, served with PDF.js (SIL Open Font License 1.1)', file: join(pkgDir('pdfjs-dist'), 'standard_fonts', 'LICENSE_LIBERATION') },
    { title: 'OpenJPEG, compiled to WebAssembly for PDF.js (BSD-2-Clause)', file: join(pkgDir('pdfjs-dist'), 'wasm', 'LICENSE_OPENJPEG') },
    { title: 'PDF.js OpenJPEG wrapper (Apache-2.0)', file: join(pkgDir('pdfjs-dist'), 'wasm', 'LICENSE_PDFJS_OPENJPEG') },
    { title: 'JBIG2 decoder from PDFium, compiled to WebAssembly for PDF.js (BSD-3-Clause)', file: join(pkgDir('pdfjs-dist'), 'wasm', 'LICENSE_JBIG2') },
    { title: 'PDF.js JBIG2 wrapper (Apache-2.0)', file: join(pkgDir('pdfjs-dist'), 'wasm', 'LICENSE_PDFJS_JBIG2') },
    { title: 'qcms colour management, compiled to WebAssembly for PDF.js (MIT)', file: join(pkgDir('pdfjs-dist'), 'wasm', 'LICENSE_QCMS') },
    { title: 'PDF.js qcms wrapper (Apache-2.0)', file: join(pkgDir('pdfjs-dist'), 'wasm', 'LICENSE_PDFJS_QCMS') },
    { title: 'ICC profile served with PDF.js (CC0-1.0)', file: join(pkgDir('pdfjs-dist'), 'iccs', 'LICENSE') },
    // PDF and Word writing.
    { title: 'pdf-lib (MIT) — https://github.com/Hopding/pdf-lib', file: join(pkgDir('pdf-lib'), 'LICENSE.md') },
    { title: '@pdf-lib/standard-fonts, bundled in pdf-lib (MIT)', file: join(pkgDir('@pdf-lib/standard-fonts'), 'LICENSE.md') },
    { title: '@pdf-lib/upng, bundled in pdf-lib (MIT)', file: join(pkgDir('@pdf-lib/upng'), 'LICENSE') },
    { title: 'tslib, bundled in pdf-lib (0BSD)', file: join(pkgDir('tslib'), 'LICENSE.txt') },
    { title: 'docx (MIT) — https://github.com/dolanmiu/docx', file: join(pkgDir('docx'), 'LICENSE') },
    {
      // The npm package declares Apache-2.0 but ships no licence file, so the
      // standard Apache-2.0 text is reproduced from another package.
      title: 'MediaPipe selfie segmentation model, from @mediapipe/selfie_segmentation (Apache-2.0, Copyright Google LLC) — https://github.com/google-ai-edge/mediapipe',
      file: join(pkgDir('wasm-feature-detect'), 'LICENSE'),
    },
    { title: 'nanoid, bundled in docx (MIT)', file: join(pkgDir('nanoid'), 'LICENSE') },
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
        source: `OpenConverter includes the following third-party software. The exceljs browser build also bundles saxes and xmlchars (ISC, by Louis-Dominique Dubeau) and other small MIT-licensed packages; their notices are kept in the code. docx also bundles hash.js (MIT, by Fedor Indutny).\n\n${body}`,
      });
    },
  };
}

export default defineConfig({
  base,
  plugins: [htmlPlugin(), thirdPartyNoticesPlugin(), pdfjsAssetsPlugin(), segmentationModelPlugin()],
  // The WebP WASM encoder must not be pre-bundled, or its .wasm file is lost.
  optimizeDeps: { exclude: ['@jsquash/webp'] },
  build: {
    target: 'es2022',
    sourcemap: true,
    // OUT_DIR lets the subpath build sit beside the root build for testing.
    outDir: process.env.OUT_DIR ?? 'dist',
    emptyOutDir: true,
    // The lazily loaded libraries (PDF, Word, Excel) are large but only
    // downloaded when used.
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // pdf.js's worker ships as .mjs, which some static hosts serve as
        // binary data; browsers then refuse to start it. Name it .js.
        assetFileNames: (info) => (info.names?.some((n) => n.endsWith('.mjs')) ? 'assets/[name]-[hash].js' : 'assets/[name]-[hash][extname]'),
      },
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
