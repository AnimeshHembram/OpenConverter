import { expect, test, type Page } from '@playwright/test';
import { sniff } from '../../src/core/detect';
import { addFiles, convertAndDownload, installDecodeGate, open, pixelsAt } from './helpers';

/**
 * The image tools beyond format conversion: PDF output, grayscale and black
 * and white, background removal and compression to a size limit. Outputs are
 * checked byte by byte and pixel by pixel, not just by their file names.
 */

type Kind = 'product' | 'bands' | 'noise';

/**
 * Draw a test image in the page:
 * - product: a red rectangle on a plain white 200×150 background;
 * - bands: four 10 px bands (red, green, blue, mid grey), 40×10;
 * - noise: 800×600 of deterministic pseudo-random pixels (hard to compress).
 */
async function paint(page: Page, kind: Kind, mime: string, quality = 0.95): Promise<Buffer> {
  const arr = await page.evaluate(
    async ({ kind, mime, quality }) => {
      const c = document.createElement('canvas');
      const g = c.getContext('2d')!;
      if (kind === 'product') {
        c.width = 200;
        c.height = 150;
        g.fillStyle = '#ffffff';
        g.fillRect(0, 0, 200, 150);
        g.fillStyle = 'rgb(220, 30, 30)';
        g.fillRect(60, 40, 80, 70);
      } else if (kind === 'bands') {
        c.width = 40;
        c.height = 10;
        ['rgb(255,0,0)', 'rgb(0,255,0)', 'rgb(0,0,255)', 'rgb(128,128,128)'].forEach((col, i) => {
          g.fillStyle = col;
          g.fillRect(i * 10, 0, 10, 10);
        });
      } else {
        c.width = 800;
        c.height = 600;
        const img = g.createImageData(800, 600);
        let seed = 12345;
        for (let i = 0; i < img.data.length; i++) {
          seed = (seed * 1103515245 + 12345) >>> 0;
          img.data[i] = i % 4 === 3 ? 255 : seed >>> 24;
        }
        g.putImageData(img, 0, 0);
      }
      const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), mime, quality));
      return [...new Uint8Array(await blob.arrayBuffer())];
    },
    { kind, mime, quality },
  );
  return Buffer.from(arr);
}

/** Pull the embedded page JPEG out of a PDF written by OpenConverter. */
function pdfImage(pdf: Buffer): { jpeg: Buffer; dict: string } {
  const text = pdf.toString('latin1');
  const m = /<< \/Type \/XObject \/Subtype \/Image [^>]*\/Length (\d+) >>\nstream\n/.exec(text);
  expect(m, 'image XObject in the PDF').not.toBeNull();
  const start = m!.index + m![0].length;
  return { jpeg: pdf.subarray(start, start + Number(m![1])), dict: m![0] };
}

const near = (actual: number[], expected: number[], tol: number) => expected.every((v, i) => Math.abs(actual[i]! - v) <= tol);

test('the input format is detected from the file itself, whatever its name', async ({ page }) => {
  await open(page);
  const jpeg = await paint(page, 'product', 'image/jpeg');
  await addFiles(page, [{ name: 'photo.png', mimeType: 'image/png', buffer: jpeg }]);
  const card = page.getByTestId('file-card');
  await expect(card).toContainText('JPEG · 200 × 150');
  await expect(card).toContainText('named .png but is actually a JPEG');
});

test('an image is saved as a one-page PDF that embeds the picture at its full size', async ({ page }) => {
  const errors = await open(page);
  const png = await paint(page, 'product', 'image/png');
  await addFiles(page, [{ name: 'product.png', mimeType: 'image/png', buffer: png }]);
  await page.getByTestId('target').selectOption('pdf');
  await expect(page.getByText('Each image becomes a one-page PDF')).toBeVisible();
  await expect(page.getByTestId('quality')).toBeVisible(); // the page image is a JPEG
  const { name, bytes, card } = await convertAndDownload(page);

  expect(name).toBe('product.pdf');
  expect(sniff(bytes).formatId).toBe('pdf');
  const text = bytes.toString('latin1');
  expect(text).toContain('/MediaBox [0 0 150 112.5]'); // 200 × 150 px at 96 px per inch
  expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  const { jpeg, dict } = pdfImage(bytes);
  expect(dict).toContain('/Width 200 /Height 150');
  expect(dict).toContain('/Filter /DCTDecode');
  const { width, height, rgba } = await pixelsAt(page, jpeg, 'image/jpeg', [[5, 5], [100, 75]]);
  expect([width, height]).toEqual([200, 150]);
  expect(near(rgba[0]!, [255, 255, 255, 255], 6)).toBe(true);
  expect(near(rgba[1]!, [220, 30, 30, 255], 12)).toBe(true);

  // The row shows a document tile, and the preview offers the browser's PDF viewer.
  await expect(card.locator('.preview-after .thumb-doc')).toHaveText('PDF');
  await expect(card.getByRole('img', { name: /^Converted/ })).toHaveCount(0);
  await card.getByTestId('preview').click();
  const dialog = page.getByTestId('preview-dialog');
  await expect(dialog).toContainText('One-page PDF document');
  await expect(dialog.getByTestId('open-pdf')).toHaveAttribute('href', /^blob:/);
  await expect(dialog.getByRole('button', { name: 'Download product.pdf' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('PDFs are still rejected as input, with a clear message', async ({ page }) => {
  await open(page);
  await addFiles(page, [{ name: 'doc.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\n%stuff\n') }]);
  await expect(page.getByTestId('file-card')).toContainText("PDF files can't be converted yet");
});

test('grayscale uses perceptual weights and keeps the image size', async ({ page }) => {
  await open(page);
  const png = await paint(page, 'bands', 'image/png');
  await addFiles(page, [{ name: 'bands.png', mimeType: 'image/png', buffer: png }]);
  await page.getByTestId('target').selectOption('png');
  await page.getByTestId('colour').selectOption('grayscale');
  const { bytes } = await convertAndDownload(page);
  const { width, height, rgba } = await pixelsAt(page, bytes, 'image/png', [[5, 5], [15, 5], [25, 5], [35, 5]]);
  expect([width, height]).toEqual([40, 10]);
  // Rec. 709: red 54, green 182, blue 18, grey unchanged.
  expect(rgba).toEqual([
    [54, 54, 54, 255],
    [182, 182, 182, 255],
    [18, 18, 18, 255],
    [128, 128, 128, 255],
  ]);
});

test('black and white produces only pure black and pure white pixels', async ({ page }) => {
  await open(page);
  const png = await paint(page, 'bands', 'image/png');
  await addFiles(page, [{ name: 'bands.png', mimeType: 'image/png', buffer: png }]);
  await page.getByTestId('target').selectOption('png');
  await page.getByTestId('colour').selectOption('bw');
  const { bytes } = await convertAndDownload(page);
  const points: [number, number][] = [];
  for (let x = 0; x < 40; x += 3) for (let y = 0; y < 10; y += 3) points.push([x, y]);
  const { rgba } = await pixelsAt(page, bytes, 'image/png', points);
  const values = new Set(rgba.map((p) => `${p[0]},${p[1]},${p[2]}`));
  expect([...values].sort()).toEqual(['0,0,0', '255,255,255']);
  // Green (the brightest band) is white; blue (the darkest) is black.
  const at = (x: number) => rgba[points.findIndex((p) => p[0] >= x)]!;
  expect(at(12)[0]).toBe(255);
  expect(at(21)[0]).toBe(0);
});

test('remove background makes a plain background transparent in PNG and keeps the subject', async ({ page }) => {
  const errors = await open(page);
  // A JPEG input, so the background has compression noise to tolerate.
  const jpeg = await paint(page, 'product', 'image/jpeg', 0.9);
  await addFiles(page, [{ name: 'product.jpg', mimeType: 'image/jpeg', buffer: jpeg }]);
  await page.getByTestId('target').selectOption('png');
  await expect(page.getByTestId('bg-tolerance')).toBeHidden();
  await page.getByTestId('remove-bg').check();
  await expect(page.getByTestId('bg-tolerance')).toBeVisible();
  const { name, bytes, card } = await convertAndDownload(page);

  expect(name).toBe('product.png');
  const { rgba } = await pixelsAt(page, bytes, 'image/png', [[0, 0], [199, 149], [30, 75], [100, 75], [65, 45]]);
  expect(rgba[0]![3]).toBe(0);
  expect(rgba[1]![3]).toBe(0);
  expect(rgba[2]![3]).toBe(0);
  expect(rgba[3]![3]).toBe(255);
  expect(near(rgba[3]!, [220, 30, 30, 255], 14)).toBe(true);
  expect(rgba[4]![3]).toBe(255); // just inside the subject's corner
  await expect(card.locator('.msg')).toHaveCount(0); // a clean result needs no caveats
  expect(errors).toEqual([]);
});

test('remove background with JPEG replaces the background with the chosen colour and says so', async ({ page }) => {
  await open(page);
  const png = await paint(page, 'product', 'image/png');
  await addFiles(page, [{ name: 'product.png', mimeType: 'image/png', buffer: png }]);
  await page.getByTestId('target').selectOption('jpeg');
  await page.getByTestId('remove-bg').check();
  await expect(page.getByLabel('Background colour', { exact: true })).toHaveAttribute('type', 'color');
  await page.getByTestId('background').fill('#00ff00');
  const { bytes, card } = await convertAndDownload(page);
  const { rgba } = await pixelsAt(page, bytes, 'image/jpeg', [[5, 5], [100, 75]]);
  expect(near(rgba[0]!, [0, 255, 0, 255], 10)).toBe(true);
  expect(near(rgba[1]!, [220, 30, 30, 255], 14)).toBe(true);
  await expect(card).toContainText('The background was replaced with #00ff00');
});

test('remove background warns when the background is not one plain colour', async ({ page }) => {
  test.slow();
  await open(page);
  const noise = await paint(page, 'noise', 'image/png');
  await addFiles(page, [{ name: 'busy.png', mimeType: 'image/png', buffer: noise }]);
  await page.getByTestId('target').selectOption('png');
  await page.getByTestId('remove-bg').check();
  const { card } = await convertAndDownload(page);
  await expect(card.locator('.msg-warning')).toContainText(/plain (background|colour)/);
});

test('compress to under a size limit lowers the quality until the file fits', async ({ page }) => {
  test.slow();
  await open(page);
  const noise = await paint(page, 'noise', 'image/jpeg', 0.95);
  expect(noise.length).toBeGreaterThan(300 * 1024); // noise really is hard to compress
  await addFiles(page, [{ name: 'noise.jpg', mimeType: 'image/jpeg', buffer: noise }]);
  await page.getByTestId('target').selectOption('jpeg');
  await page.getByTestId('quality').fill('95');
  await page.getByTestId('max-size').fill('150');
  const { bytes, card } = await convertAndDownload(page);
  expect(sniff(bytes).formatId).toBe('jpeg');
  expect(bytes.length).toBeLessThanOrEqual(150 * 1024);
  expect(bytes.length).toBeGreaterThan(60 * 1024); // the best fit, not the lowest quality
  await expect(card).toContainText(/Compressed to fit under 150 KB, at \d+% quality/);
  await expect(card.getByTestId('status')).toContainText('smaller');
});

test('an impossible size limit keeps the smallest version and explains why', async ({ page }) => {
  test.slow();
  await open(page);
  const noise = await paint(page, 'noise', 'image/png');
  await addFiles(page, [{ name: 'noise.png', mimeType: 'image/png', buffer: noise }]);
  await page.getByTestId('target').selectOption('jpeg');
  await page.getByTestId('max-size').fill('2');
  const { bytes, card } = await convertAndDownload(page);
  expect(sniff(bytes).formatId).toBe('jpeg');
  await expect(card).toContainText(/couldn't be compressed under 2\.0 KB, even at the lowest quality/);
});

test('the size limit accepts KB or MB, flags bad input, and only shows for lossy formats', async ({ page }) => {
  await open(page);
  const png = await paint(page, 'bands', 'image/png');
  await addFiles(page, [{ name: 'bands.png', mimeType: 'image/png', buffer: png }]);
  await page.getByTestId('target').selectOption('jpeg');
  const box = page.getByTestId('max-size');
  await box.fill('abc');
  await expect(box).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('Enter a number, e.g. 200')).toBeVisible();
  await box.fill('1.5');
  await page.getByTestId('max-size-unit').selectOption('MB');
  await expect(box).toHaveAttribute('aria-invalid', 'false');
  expect(await page.evaluate(() => (window as any).openconvert.controller.snapshot.settings.maxBytes)).toBe(1.5 * 1024 * 1024);
  await page.getByTestId('target').selectOption('png');
  await expect(box).toBeHidden(); // lossless: nothing to compress
});

test('changing an edit marks earlier results as out of date', async ({ page }) => {
  await open(page);
  const png = await paint(page, 'bands', 'image/png');
  await addFiles(page, [{ name: 'bands.png', mimeType: 'image/png', buffer: png }]);
  await page.getByTestId('target').selectOption('png');
  const { card } = await convertAndDownload(page);
  await expect(card.getByTestId('status')).not.toContainText('settings changed');
  await page.getByTestId('colour').selectOption('grayscale');
  await expect(card.getByTestId('status')).toContainText('settings changed');
  await expect(page.getByTestId('convert')).toBeEnabled();
});

test('settings are locked while a batch converts, and unlocked afterwards', async ({ page }) => {
  await open(page);
  const png = await paint(page, 'bands', 'image/png');
  await addFiles(page, [{ name: 'bands.png', mimeType: 'image/png', buffer: png }]);
  const gate = await installDecodeGate(page);
  await gate.close();
  await page.getByTestId('convert').click();
  await gate.blocked();
  for (const id of ['target', 'quality', 'colour', 'remove-bg']) await expect(page.getByTestId(id)).toBeDisabled();
  await gate.open();
  await expect(page.getByTestId('file-card')).toHaveAttribute('data-status', 'done');
  for (const id of ['target', 'quality', 'colour', 'remove-bg']) await expect(page.getByTestId(id)).toBeEnabled();
});
