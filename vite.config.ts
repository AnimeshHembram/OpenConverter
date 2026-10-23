import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

// GitHub Pages serves project sites from /<repo-name>/. The deploy workflow
// sets BASE_PATH; locally the site is served from the root.
const base = process.env.BASE_PATH ?? '/';

/**
 * Content-Security-Policy for the production build. `connect-src 'self'`
 * makes the browser itself block requests to any other site, which backs up
 * the "files never leave your device" promise (the static host accepts no
 * uploads). GitHub Pages cannot set headers, so it is delivered as a <meta>
 * tag. Not applied in dev, where Vite needs a websocket for hot reload.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "connect-src 'self'", // same-origin only: needed to load the .wasm encoder
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function cspPlugin(): Plugin {
  return {
    name: 'openconvert-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
    },
  };
}

export default defineConfig({
  base,
  plugins: [cspPlugin()],
  // The WebP WASM encoder must not be pre-bundled, or its .wasm file is lost.
  optimizeDeps: { exclude: ['@jsquash/webp'] },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
