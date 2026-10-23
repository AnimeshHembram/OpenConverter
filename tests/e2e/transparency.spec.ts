import { expect, test } from '@playwright/test';
import { sniff } from '../../src/core/detect';
import { addFiles, bmpPixel, convertAndDownload, makeImage, makeThinTransparencyPng, open, pixelsAt } from './helpers';

/**
 * Regression tests for the two transparency defects found in the Phase 1
 * audit: thin transparent features were invisible to a 256-pixel downscaled
 * probe, so JPEG output got dark pixels and BMP output lost its alpha.
 */

const SIZE = 2000;
const MID = SIZE / 2;
const near = (actual: number[], expected: number[], tol: number) =>
  expected.every((v, i) => Math.abs(actual[i]! - v) <= tol);

test('thin transparent features in a large PNG are filled with the chosen colour in JPEG', async ({ page }) => {
  test.slow();
  const errors = await open(page);
  const png = await makeThinTransparencyPng(page, SIZE);
  await addFiles(page, [{ name: 'thin.png', mimeType: 'image/png', buffer: png }]);
  await page.getByTestId('target').selectOption('jpeg');
  await page.getByTestId('background').fill('#00ff00'); // distinctive, so a black or red result can't pass
  const { name, bytes, card } = await convertAndDownload(page);

  expect(name).toBe('thin.jpg');
  expect(sniff(bytes).formatId).toBe('jpeg');
  const { width, height, rgba } = await pixelsAt(page, bytes, 'image/jpeg', [
    [500, MID], // on the transparent row
    [0, 500], // on the transparent column
    [500, 500], // opaque area
  ]);
  expect([width, height]).toEqual([SIZE, SIZE]);
  // JPEG is lossy and chroma-subsampled; a 1-pixel line bleeds into its
  // red neighbours, so check "clearly green, not dark" rather than exact.
  const [row, col, opaque] = rgba as [number[], number[], number[]];
  for (const px of [row, col]) {
    expect(px[1], `green channel at transparent pixel ${px}`).toBeGreaterThan(120);
    expect(px[0]! + px[1]! + px[2]!, `not dark: ${px}`).toBeGreaterThan(200);
  }
  expect(near(opaque, [220, 30, 30, 255], 12), `opaque area unchanged: ${opaque}`).toBe(true);
  await expect(card).toContainText('Transparent areas were filled with #00ff00');
  expect(errors).toEqual([]);
});

test('thin transparent features in a large PNG are preserved as a 32-bit BMP', async ({ page }) => {
  test.slow();
  const errors = await open(page);
  const png = await makeThinTransparencyPng(page, SIZE);
  await addFiles(page, [{ name: 'thin.png', mimeType: 'image/png', buffer: png }]);
  await page.getByTestId('target').selectOption('bmp');
  const { name, bytes, card } = await convertAndDownload(page);

  expect(name).toBe('thin.bmp');
  expect(sniff(bytes).formatId).toBe('bmp');
  expect(bytes.readUInt16LE(28)).toBe(32);
  expect(bytes.readUInt32LE(2)).toBe(bytes.length); // header file size is correct
  expect(bmpPixel(bytes, 500, MID)[3]).toBe(0);
  expect(bmpPixel(bytes, 0, 500)[3]).toBe(0);
  expect(bmpPixel(bytes, 500, 500)).toEqual([220, 30, 30, 255]);
  await expect(card).toContainText('32-bit BMP');
  expect(errors).toEqual([]);
});

test('opaque PNG → BMP stays 24-bit with no transparency warning', async ({ page }) => {
  await open(page);
  const png = await makeImage(page, { mime: 'image/png', width: 300, height: 200 });
  await addFiles(page, [{ name: 'solid.png', mimeType: 'image/png', buffer: png }]);
  await page.getByTestId('target').selectOption('bmp');
  const { bytes, card } = await convertAndDownload(page);
  expect(bytes.readUInt16LE(28)).toBe(24);
  expect(bmpPixel(bytes, 150, 100)).toEqual([220, 30, 30, 255]);
  await expect(card).not.toContainText('32-bit');
  await expect(card).not.toContainText('Transparent areas');
});

test('opaque PNG → JPEG keeps its colours and shows no transparency warning', async ({ page }) => {
  await open(page);
  const png = await makeImage(page, { mime: 'image/png', width: 300, height: 200 });
  await addFiles(page, [{ name: 'solid.png', mimeType: 'image/png', buffer: png }]);
  await page.getByTestId('target').selectOption('jpeg');
  await page.getByTestId('background').fill('#00ff00');
  const { bytes, card } = await convertAndDownload(page);
  const { rgba } = await pixelsAt(page, bytes, 'image/jpeg', [[0, 0], [150, 100], [299, 199]]);
  for (const px of rgba) expect(near(px, [220, 30, 30, 255], 12), `pixel ${px}`).toBe(true);
  await expect(card).not.toContainText('Transparent areas');
});

test('BMP with alpha → JPEG fills transparent pixels; opaque BMP → BMP round-trips exactly', async ({ page }) => {
  await open(page);
  const { encodeBmp } = await import('../../src/modules/image/bmp');
  // 64x64, opaque blue except one transparent row at y = 32.
  const w = 64;
  const data = new Uint8ClampedArray(w * w * 4);
  for (let i = 0; i < data.length; i += 4) data.set([20, 40, 200, Math.floor(i / 4 / w) === 32 ? 0 : 255], i);
  const alphaBmp = Buffer.from(encodeBmp({ width: w, height: w, data }, { alpha: true }));
  await addFiles(page, [{ name: 'a.bmp', mimeType: 'image/bmp', buffer: alphaBmp }]);
  await page.getByTestId('target').selectOption('jpeg');
  await page.getByTestId('background').fill('#ffffff');
  const jpg = await convertAndDownload(page);
  const { rgba } = await pixelsAt(page, jpg.bytes, 'image/jpeg', [[10, 32], [10, 10]]);
  expect(rgba[0]![0]! + rgba[0]![1]!, `transparent row is light, not black: ${rgba[0]}`).toBeGreaterThan(300);
  expect(near(rgba[1]!, [20, 40, 200, 255], 14)).toBe(true);
  await expect(jpg.card).toContainText('Transparent areas were filled');

  await page.getByTestId('clear').click();
  const opaque = new Uint8ClampedArray(w * w * 4);
  for (let i = 0; i < opaque.length; i += 4) opaque.set([(i * 7) & 255, (i * 13) & 255, (i * 3) & 255, 255], i);
  const opaqueBmp = Buffer.from(encodeBmp({ width: w, height: w, data: opaque }, { alpha: false }));
  await addFiles(page, [{ name: 'o.bmp', mimeType: 'image/bmp', buffer: opaqueBmp }]);
  await page.getByTestId('target').selectOption('bmp');
  const out = await convertAndDownload(page);
  expect(out.bytes.readUInt16LE(28)).toBe(24);
  expect(Buffer.compare(out.bytes, opaqueBmp)).toBe(0);
});
