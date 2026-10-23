import { expect, test } from '@playwright/test';
import { sniff } from '../../src/core/detect';
import { decodeBmp, encodeBmp } from '../../src/modules/image/bmp';
import { addFiles, convertAndDownload, makeImage, open, pixelAt } from './helpers';

/**
 * Real conversions in a real browser. Test images are drawn with canvas in
 * the page, converted through the UI, downloaded, and the downloaded bytes
 * are checked: magic bytes, MIME, extension, dimensions and pixel values.
 */

test('PNG with transparency → JPEG fills the background and labels the file correctly', async ({ page }) => {
  const errors = await open(page);
  const png = await makeImage(page, { mime: 'image/png', width: 64, height: 40, transparentHalf: true });
  await addFiles(page, [{ name: 'logo.png', mimeType: 'image/png', buffer: png }]);
  await expect(page.getByTestId('file-card').first()).toContainText('PNG · 64 × 40');

  await page.getByTestId('target').selectOption('jpeg');
  await expect(page.getByTestId('quality')).toBeVisible();
  const { name, bytes, card } = await convertAndDownload(page);

  expect(name).toBe('logo.jpg');
  expect(sniff(bytes).formatId).toBe('jpeg');
  await expect(card).toContainText('Transparent areas were filled with #ffffff');
  const px = await pixelAt(page, bytes, 'image/jpeg', 60, 20);
  expect(px.width).toBe(64);
  expect(px.height).toBe(40);
  expect(Math.min(...px.rgba.slice(0, 3))).toBeGreaterThan(240); // white, not black
  expect(errors).toEqual([]);
});

test('PNG → WebP keeps transparency (browser default encoder)', async ({ page }) => {
  const errors = await open(page);
  const png = await makeImage(page, { mime: 'image/png', width: 50, height: 50, transparentHalf: true });
  await addFiles(page, [{ name: 'icon.png', mimeType: 'image/png', buffer: png }]);
  await page.getByTestId('target').selectOption('webp');
  const { name, bytes } = await convertAndDownload(page);
  expect(name).toBe('icon.webp');
  expect(sniff(bytes).formatId).toBe('webp');
  expect((await pixelAt(page, bytes, 'image/webp', 45, 25)).rgba[3]).toBe(0);
  expect((await pixelAt(page, bytes, 'image/webp', 5, 25)).rgba[3]).toBe(255);
  expect(errors).toEqual([]);
});

test('WebP falls back to the WASM encoder when the browser has none', async ({ page }) => {
  const errors = await open(page, '?noNative=webp');
  await expect(page.getByTestId('target').locator('option[value=webp]')).toContainText('built-in encoder');
  const png = await makeImage(page, { mime: 'image/png', width: 40, height: 30, transparentHalf: true });
  await addFiles(page, [{ name: 'safari.png', mimeType: 'image/png', buffer: png }]);
  await page.getByTestId('target').selectOption('webp');
  const { name, bytes } = await convertAndDownload(page);
  expect(name).toBe('safari.webp');
  expect(sniff(bytes).formatId).toBe('webp');
  const px = await pixelAt(page, bytes, 'image/webp', 35, 15);
  expect(px.width).toBe(40);
  expect(px.rgba[3]).toBe(0);
  expect(errors).toEqual([]);
});

test('PNG → BMP writes a 32-bit BMP that preserves alpha', async ({ page }) => {
  await open(page);
  const png = await makeImage(page, { mime: 'image/png', width: 21, height: 9, transparentHalf: true });
  await addFiles(page, [{ name: 'sprite.png', mimeType: 'image/png', buffer: png }]);
  await page.getByTestId('target').selectOption('bmp');
  const { name, bytes, card } = await convertAndDownload(page);
  expect(name).toBe('sprite.bmp');
  const img = decodeBmp(new Uint8Array(bytes));
  expect([img.width, img.height]).toEqual([21, 9]);
  expect(img.data[3]).toBe(255); // left: opaque
  expect(img.data[(20 * 4) + 3]).toBe(0); // right: transparent
  await expect(card).toContainText('32-bit BMP');
});

test('JPEG → BMP is 24-bit, and BMP input converts to PNG', async ({ page }) => {
  await open(page);
  const jpg = await makeImage(page, { mime: 'image/jpeg', width: 30, height: 20 });
  await addFiles(page, [{ name: 'photo.jpeg', mimeType: 'image/jpeg', buffer: jpg }]);
  await page.getByTestId('target').selectOption('bmp');
  const { bytes } = await convertAndDownload(page);
  expect(bytes.readUInt16LE(28)).toBe(24);

  await page.getByTestId('clear').click();
  const raw = new Uint8ClampedArray(8 * 6 * 4);
  for (let i = 0; i < raw.length; i += 4) raw.set([10, 200, 30, i < raw.length / 2 ? 255 : 128], i);
  const bmp = Buffer.from(encodeBmp({ width: 8, height: 6, data: raw }, { alpha: true }));
  await addFiles(page, [{ name: 'old.bmp', mimeType: 'image/bmp', buffer: bmp }]);
  await page.getByTestId('target').selectOption('png');
  const out = await convertAndDownload(page);
  expect(out.name).toBe('old.png');
  expect(sniff(out.bytes).formatId).toBe('png');
  const top = await pixelAt(page, out.bytes, 'image/png', 0, 0);
  const bottom = await pixelAt(page, out.bytes, 'image/png', 0, 5);
  expect(top.rgba).toEqual([10, 200, 30, 255]);
  expect(bottom.rgba[3]).toBe(128);
});

test('JPEG → JPEG at lower quality makes a smaller file', async ({ page }) => {
  await open(page);
  // Noise compresses badly, so quality has a visible effect on size.
  const arr = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d')!;
    const d = g.createImageData(256, 256);
    for (let i = 0; i < d.data.length; i++) d.data[i] = i % 4 === 3 ? 255 : (i * 2654435761) % 256;
    g.putImageData(d, 0, 0);
    const b: Blob = await new Promise((r) => c.toBlob((x) => r(x!), 'image/jpeg', 0.98));
    return [...new Uint8Array(await b.arrayBuffer())];
  });
  const src = Buffer.from(arr);
  await addFiles(page, [{ name: 'noise.jpg', mimeType: 'image/jpeg', buffer: src }]);
  await page.getByTestId('target').selectOption('jpeg');
  await page.getByTestId('quality').fill('30');
  const { bytes, card } = await convertAndDownload(page);
  expect(bytes.length).toBeLessThan(src.length / 2);
  await expect(card).toContainText('smaller');
});

test('batch conversion downloads a ZIP with one correctly named entry per file', async ({ page }) => {
  await open(page);
  const a = await makeImage(page, { mime: 'image/png', width: 10, height: 10 });
  const b = await makeImage(page, { mime: 'image/jpeg', width: 12, height: 8 });
  await addFiles(page, [
    { name: 'a.png', mimeType: 'image/png', buffer: a },
    { name: 'b.jpg', mimeType: 'image/jpeg', buffer: b },
    { name: 'a.jpeg', mimeType: 'image/jpeg', buffer: b },
  ]);
  await page.getByTestId('target').selectOption('png');
  await expect(page.getByTestId('convert')).toHaveText('Convert 3 files');
  await page.getByTestId('convert').click();
  await expect(page.locator('[data-testid=file-card][data-status=done]')).toHaveCount(3);
  await expect(page.getByTestId('download-all')).toHaveText('Download all (3) as ZIP');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download-all').click()]);
  expect(dl.suggestedFilename()).toBe('openconvert-3-png.zip');
  const fs = await import('node:fs/promises');
  const zip = await fs.readFile((await dl.path())!);
  const names: string[] = [];
  const eocd = zip.length - 22;
  let p = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < zip.readUInt16LE(eocd + 10); i++) {
    const len = zip.readUInt16LE(p + 28);
    names.push(zip.subarray(p + 46, p + 46 + len).toString('utf8'));
    p += 46 + len;
  }
  expect(names).toEqual(['a.png', 'b.png', 'a (2).png']);

  // Changing settings marks results stale and re-enables Convert.
  await page.getByTestId('target').selectOption('jpeg');
  await expect(page.getByTestId('convert')).toBeEnabled();
  await expect(page.getByTestId('file-card').first()).toContainText('settings changed');
});

test('rejects unsupported and fake files with clear messages, and warns on wrong extensions', async ({ page }) => {
  await open(page);
  const png = await makeImage(page, { mime: 'image/png', width: 4, height: 4 });
  await addFiles(page, [
    { name: 'notes.png', mimeType: 'image/png', buffer: Buffer.from('definitely not an image') },
    { name: 'anim.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00') },
    { name: 'misnamed.jpg', mimeType: 'image/jpeg', buffer: png },
  ]);
  const cards = page.getByTestId('file-card');
  await expect(cards.nth(0)).toHaveAttribute('data-status', 'error');
  await expect(cards.nth(0)).toContainText("doesn't look like a PNG, JPEG, WebP or BMP");
  await expect(cards.nth(1)).toContainText("GIF files aren't supported yet");
  await expect(cards.nth(2)).toContainText('named .jpg but is actually a PNG');
  await expect(page.getByTestId('convert')).toHaveText('Convert'); // only the valid one
});

test('cleans up object URLs when files are removed or cleared', async ({ page }) => {
  await open(page);
  const png = await makeImage(page, { mime: 'image/png', width: 8, height: 8 });
  await addFiles(page, [
    { name: 'one.png', mimeType: 'image/png', buffer: png },
    { name: 'two.png', mimeType: 'image/png', buffer: png },
  ]);
  await page.getByTestId('target').selectOption('jpeg');
  await page.getByTestId('convert').click();
  await expect(page.locator('[data-status=done]')).toHaveCount(2);
  const live = () => page.evaluate(() => (window as any).openconvert.controller.liveObjectUrls as number);
  expect(await live()).toBe(4); // a preview and a result for each file
  await page.getByTestId('file-card').first().getByTestId('remove').click();
  expect(await live()).toBe(2);
  await page.getByTestId('clear').click();
  expect(await live()).toBe(0);
  await expect(page.getByTestId('file-card')).toHaveCount(0);
});

test('makes no requests to other origins while converting', async ({ page, baseURL }) => {
  const foreign: string[] = [];
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith(baseURL!) && !u.startsWith('blob:') && !u.startsWith('data:')) foreign.push(u);
  });
  await open(page, '?noNative=webp'); // include the lazily-loaded WASM path
  const png = await makeImage(page, { mime: 'image/png', width: 16, height: 16 });
  await addFiles(page, [{ name: 'p.png', mimeType: 'image/png', buffer: png }]);
  await page.getByTestId('target').selectOption('webp');
  await convertAndDownload(page);
  expect(foreign).toEqual([]);
  // The production CSP is present.
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content', /connect-src 'self'/);
});
