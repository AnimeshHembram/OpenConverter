import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sniff } from '../../src/core/detect';
import { makeImage } from './helpers';

/**
 * The standalone build (`dist-standalone/index.html`, made by `npm run
 * build`) opened straight from disk, as when double-clicked: no server.
 */
const FILE_URL = pathToFileURL(resolve('dist-standalone/index.html')).href;

test('opened from disk, the full app works under its strict CSP', async ({ page, browserName }) => {
  const errors: string[] = [];
  const requests: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => requests.push(r.url()));

  await page.goto(FILE_URL);
  await expect(page.locator('#app')).not.toHaveAttribute('aria-busy');
  await expect(page.getByTestId('dropzone')).toBeVisible();
  await expect(page.locator('.boot-hint')).toHaveCount(0);
  // Styles applied (inlined CSS): the brand is set in the design's weight.
  expect(await page.locator('.brand').evaluate((el) => getComputedStyle(el).fontWeight)).toBe('650');
  // The CSP is still present, now with hashes rather than 'unsafe-inline'.
  const csp = (await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'))!;
  expect(csp).toContain("connect-src 'self'");
  expect(csp).not.toContain('unsafe-inline');

  // Theme switch works.
  await page.getByTestId('theme-switch').click();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');

  // A real conversion and download.
  const png = await makeImage(page, { mime: 'image/png', width: 30, height: 20, transparentHalf: true });
  await page.getByTestId('file-input').setInputFiles([{ name: 'disk.png', mimeType: 'image/png', buffer: png }]);
  await page.getByTestId('target').selectOption('jpeg');
  await page.getByTestId('convert').click();
  const card = page.getByTestId('file-card').first();
  await expect(card).toHaveAttribute('data-status', 'done');
  const [dl] = await Promise.all([page.waitForEvent('download'), card.getByTestId('download').click()]);
  expect(dl.suggestedFilename()).toBe('disk.jpg');
  expect(sniff(await readFile((await dl.path())!)).formatId).toBe('jpeg');

  // The WASM encoder can't load from disk, so WebP is offered exactly when
  // this browser encodes it natively. Probe the engine rather than assume by
  // browser name: WebKit builds differ (Safari, WebKitGTK, Playwright's WebKit).
  const nativeWebp = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = c.height = 2;
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/webp', 0.9));
    return blob?.type === 'image/webp';
  });
  const webpOption = page.getByTestId('target').locator('option[value=webp]');
  if (nativeWebp) {
    await expect(webpOption, `${browserName} encodes WebP natively, so WebP must be offered`).toHaveCount(1);
    await expect(webpOption).not.toContainText('built-in encoder');
  } else {
    await expect(webpOption, `${browserName} has no native WebP encoder and the WASM one can't load from disk`).toHaveCount(0);
  }

  expect(
    requests.filter((u) => !u.startsWith('file:') && !u.startsWith('blob:') && !u.startsWith('data:')),
    'requests that left the device',
  ).toEqual([]);
  expect(errors, 'console and page errors').toEqual([]);
});
