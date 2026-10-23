import { expect, test } from '@playwright/test';
import { sniff } from '../../src/core/detect';
import { animatedPng, animatedWebp, fixture, rotatedJpeg } from '../fixtures/images';
import { addFiles, convertAndDownload, open, pixelsAt } from './helpers';
const isRed = (p: number[]) => p[0]! > 150 && p[2]! < 100;
const isBlue = (p: number[]) => p[2]! > 150 && p[0]! < 100;

for (const [name, mime, label, data] of [
  ['animated.png', 'image/png', 'an animated PNG (APNG)', animatedPng],
  ['animated.webp', 'image/webp', 'an animated WebP', animatedWebp],
] as const) {
  test(`${name}: warns before conversion that only the first frame is kept`, async ({ page }) => {
    const errors = await open(page);
    await addFiles(page, [{ name, mimeType: mime, buffer: fixture(data) }]);
    const card = page.getByTestId('file-card').first();
    await expect(card).toHaveAttribute('data-status', 'ready');
    await expect(card).toContainText(`This is ${label}. Only the first frame will be converted`);
    await page.getByTestId('target').selectOption('png');
    const out = await convertAndDownload(page);
    expect(sniff(out.bytes).formatId).toBe('png');
    const { width, height, rgba } = await pixelsAt(page, out.bytes, 'image/png', [[5, 16], [43, 16]]);
    expect([width, height]).toEqual([48, 32]);
    expect(isRed(rgba[0]!) && isBlue(rgba[1]!), `first frame content: ${JSON.stringify(rgba)}`).toBe(true);
    // The output is a plain PNG: no animation chunk.
    expect(out.bytes.includes(Buffer.from('acTL'))).toBe(false);
    expect(errors).toEqual([]);
  });
}

test('a rotated (EXIF orientation 6) photo shows and converts at its displayed size and orientation', async ({ page }) => {
  const errors = await open(page);
  await addFiles(page, [{ name: 'rotated.jpg', mimeType: 'image/jpeg', buffer: fixture(rotatedJpeg) }]);
  const card = page.getByTestId('file-card').first();
  await expect(card).toContainText('JPEG · 20 × 40');
  // The "before" preview is displayed the same way.
  const preview = await card.locator('img').first().evaluate(async (img: HTMLImageElement) => {
    await img.decode();
    return [img.naturalWidth, img.naturalHeight];
  });
  expect(preview).toEqual([20, 40]);

  await page.getByTestId('target').selectOption('png');
  const out = await convertAndDownload(page);
  const { width, height, rgba } = await pixelsAt(page, out.bytes, 'image/png', [[10, 5], [10, 35]]);
  expect([width, height]).toEqual([20, 40]);
  expect(isRed(rgba[0]!), `top is red: ${rgba[0]}`).toBe(true);
  expect(isBlue(rgba[1]!), `bottom is blue: ${rgba[1]}`).toBe(true);
  await expect(card).toContainText('JPEG · 20 × 40');
  await expect(card).not.toContainText('sideways');
  expect(errors).toEqual([]);
});

test('metadata such as EXIF (which can include GPS location) is not copied into the output', async ({ page }) => {
  await open(page);
  const input = fixture(rotatedJpeg);
  expect(input.includes(Buffer.from('Exif\0\0', 'latin1'))).toBe(true);
  await addFiles(page, [{ name: 'photo.jpg', mimeType: 'image/jpeg', buffer: input }]);
  for (const [target, ext] of [['jpeg', 'jpg'], ['webp', 'webp'], ['png', 'png']] as const) {
    await page.getByTestId('target').selectOption(target);
    const out = await convertAndDownload(page);
    expect(out.name).toBe(`photo.${ext}`);
    expect(out.bytes.includes(Buffer.from('Exif\0\0', 'latin1')), `${target} output has no EXIF block`).toBe(false);
    expect(out.bytes.includes(Buffer.from('eXIf', 'latin1')), `${target} output has no PNG eXIf chunk`).toBe(false);
  }
});
