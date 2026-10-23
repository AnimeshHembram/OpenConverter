import { expect, test, type Page, type Request } from '@playwright/test';
import { sniff } from '../../src/core/detect';
import { addFiles, convertAndDownload, makeImage, pixelAt } from '../e2e/helpers';

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
  await expect(page.getByTestId('target')).toBeVisible();
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
  await expect(page.getByTestId('target')).toBeVisible();
});
