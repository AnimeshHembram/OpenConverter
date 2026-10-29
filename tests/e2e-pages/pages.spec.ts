import { expect, test, type Page, type Request } from '@playwright/test';
import { sniff } from '../../src/core/detect';
import { addFiles, convertAndDownload, makeImage, pixelAt } from '../e2e/helpers';
import { buildPdf, SAMPLE_TEXT_PAGES } from '../fixtures/pdfs';
import { rainyStreet } from '../fixtures/scenes';

/**
 * The GitHub Pages build, served under its repository subpath exactly as
 * deployed. Paths in page.goto() are relative to the subpath baseURL.
 */

interface Watch {
  requests: Request[];
  failures: string[];
  errors: string[];
}

async function openPages(page: Page, query = ''): Promise<Watch> {
  const w: Watch = { requests: [], failures: [], errors: [] };
  page.on('request', (r) => w.requests.push(r));
  page.on('requestfailed', (r) => w.failures.push(`${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => {
    if (r.status() >= 400) w.failures.push(`${r.status()} ${r.url()}`);
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('[OpenConvert]')) w.errors.push(m.text());
  });
  page.on('pageerror', (e) => w.errors.push(e.message));
  await page.goto(`./${query}`);
  await expect(page.locator('#app')).not.toHaveAttribute('aria-busy');
  await expect(page.getByTestId('dropzone')).toBeVisible();
  return w;
}

function checkRequests(w: Watch, baseURL: string) {
  const base = new URL(baseURL);
  const offenders = w.requests
    .map((r) => r.url())
    .filter((u) => !u.startsWith('blob:') && !u.startsWith('data:'))
    .filter((u) => {
      const url = new URL(u);
      return url.origin !== base.origin || !url.pathname.startsWith(base.pathname);
    });
  expect(offenders, 'requests outside the deployed origin + subpath').toEqual([]);
  expect(w.failures, 'failed or 4xx/5xx requests').toEqual([]);
  expect(w.errors, 'console errors').toEqual([]);
}

test('all assets load from the subpath and native conversions download correctly', async ({ page, baseURL }) => {
  const w = await openPages(page);
  const assets = w.requests.map((r) => new URL(r.url()).pathname).filter((p) => p.includes('/assets/'));
  expect(assets.some((p) => p.endsWith('.js'))).toBe(true);
  expect(assets.some((p) => p.endsWith('.css'))).toBe(true);
  for (const p of assets) expect(p.startsWith(new URL(baseURL!).pathname)).toBe(true);

  const png = await makeImage(page, { mime: 'image/png', width: 30, height: 20, transparentHalf: true });
  await addFiles(page, [{ name: 'sub.png', mimeType: 'image/png', buffer: png }]);
  for (const [target, ext] of [['jpeg', 'jpg'], ['png', 'png'], ['bmp', 'bmp'], ['webp', 'webp']] as const) {
    await page.getByTestId('target').selectOption(target);
    const out = await convertAndDownload(page);
    expect(out.name).toBe(`sub.${ext}`);
    expect(sniff(out.bytes).formatId).toBe(target);
  }
  checkRequests(w, baseURL!);
});

test('the forced WebAssembly WebP encoder loads from the subpath and works', async ({ page, baseURL }) => {
  const w = await openPages(page, '?noNative=webp');
  const png = await makeImage(page, { mime: 'image/png', width: 30, height: 20, transparentHalf: true });
  await addFiles(page, [{ name: 'wasm.png', mimeType: 'image/png', buffer: png }]);
  await page.getByTestId('target').selectOption('webp');
  const out = await convertAndDownload(page);
  expect(sniff(out.bytes).formatId).toBe('webp');
  expect((await pixelAt(page, out.bytes, 'image/webp', 25, 10)).rgba[3]).toBe(0);
  const wasm = w.requests.map((r) => new URL(r.url()).pathname).filter((p) => p.endsWith('.wasm'));
  expect(wasm.length).toBeGreaterThan(0);
  for (const p of wasm) expect(p.startsWith(`${new URL(baseURL!).pathname}assets/`)).toBe(true);
  checkRequests(w, baseURL!);
});

test('the Content-Security-Policy meta tag is present and blocks requests to other sites', async ({ page }) => {
  await openPages(page);
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content', /connect-src 'self'/);
  const result = await page.evaluate(async () => {
    const violations: string[] = [];
    document.addEventListener('securitypolicyviolation', (e) => violations.push(e.violatedDirective));
    let fetchBlocked = false;
    try {
      await fetch('https://example.com/upload', { method: 'POST', body: 'x' });
    } catch {
      fetchBlocked = true;
    }
    await new Promise((r) => setTimeout(r, 100));
    return { fetchBlocked, violations };
  });
  expect(result.fetchBlocked).toBe(true);
  expect(result.violations.some((v) => v.startsWith('connect-src'))).toBe(true);
});

test('footer links resolve: third-party notices under the subpath, source on GitHub', async ({ page, baseURL }) => {
  await openPages(page);
  const notices = page.locator('#notices-link');
  const href = await notices.evaluate((a: HTMLAnchorElement) => a.href);
  expect(href).toBe(`${baseURL}THIRD_PARTY_NOTICES.txt`);
  const res = await page.request.get(href);
  expect(res.status()).toBe(200);
  const text = await res.text();
  expect(text).toContain('libwebp');
  expect(text).toContain('Apache License');
  expect(text).toContain('Copyright (c) 2010, Google Inc.');
  await expect(page.locator('#source-link')).toHaveAttribute('href', /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
});

test('the subpath without a trailing slash redirects, like GitHub Pages', async ({ page, baseURL }) => {
  const noSlash = baseURL!.replace(/\/$/, '');
  const res = await page.goto(noSlash);
  expect(res?.url()).toBe(baseURL);
  await expect(page.getByTestId('dropzone')).toBeVisible();
});

test('PDF conversion loads its worker and data files from the subpath', async ({ page, baseURL }) => {
  test.slow();
  const w = await openPages(page);
  // Standard (non-embedded) fonts make pdf.js fetch its font files too.
  const pdf = await buildPdf({ textPages: SAMPLE_TEXT_PAGES.slice(0, 1) });
  await addFiles(page, [{ name: 'doc.pdf', mimeType: 'application/pdf', buffer: pdf }]);
  await page.getByTestId('row-target').selectOption('png');
  const { name, bytes } = await convertAndDownload(page);
  expect(name).toBe('doc.png');
  expect(sniff(bytes).formatId).toBe('png');
  const base = new URL(baseURL!).pathname;
  const paths = w.requests.map((r) => new URL(r.url()).pathname);
  expect(paths.some((p) => p.startsWith(`${base}assets/`) && /pdf\.worker/.test(p)), 'pdf.js worker').toBe(true);
  expect(paths.some((p) => p.startsWith(`${base}assets/pdfjs/standard_fonts/`)), 'pdf.js font files').toBe(true);
  checkRequests(w, baseURL!);
});

test('photo background removal loads its model from the subpath', async ({ page, baseURL }) => {
  test.slow();
  const w = await openPages(page);
  // A person on a dark street: needs the segmentation model, not the colour key.
  const scene = rainyStreet(320, 400);
  const png = await page.evaluate(
    async ({ raw, width, height }) => {
      const bin = atob(raw);
      const px = new Uint8ClampedArray(bin.length);
      for (let i = 0; i < bin.length; i++) px[i] = bin.charCodeAt(i);
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      c.getContext('2d')!.putImageData(new ImageData(px, width, height), 0, 0);
      const u8 = new Uint8Array(await (await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'))).arrayBuffer());
      return Array.from(u8);
    },
    { raw: Buffer.from(scene.rgba.buffer).toString('base64'), width: scene.width, height: scene.height },
  );
  await addFiles(page, [{ name: 'street.png', mimeType: 'image/png', buffer: Buffer.from(png) }]);
  await page.getByTestId('target').selectOption('png');
  await page.getByTestId('remove-bg').check();
  const { bytes } = await convertAndDownload(page);
  expect(sniff(bytes).formatId).toBe('png');
  expect((await pixelAt(page, bytes, 'image/png', 2, 2)).rgba[3]).toBe(0); // background removed
  expect((await pixelAt(page, bytes, 'image/png', 166, 225)).rgba[3]).toBe(255); // dark coat kept
  const base = new URL(baseURL!).pathname;
  const paths = w.requests.map((r) => new URL(r.url()).pathname);
  expect(paths).toContain(`${base}assets/models/selfie_segmentation.tflite`);
  checkRequests(w, baseURL!);
});
