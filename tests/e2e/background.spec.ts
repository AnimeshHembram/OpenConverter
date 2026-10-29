import { expect, test, type Page } from '@playwright/test';
import { sniff } from '../../src/core/detect';
import { darkOnDark, lightOnDark, productWithShadow, rainyStreet, score, type Scene } from '../fixtures/scenes';
import { addFiles, convertAndDownload, open } from './helpers';

/**
 * Background removal, end to end in the real app: the regression case from
 * the bug report (a person in a dark coat on a dark, rainy street) plus
 * plain-background cases. Results are decoded and compared with the scenes'
 * ground truth pixel by pixel; a transparent-looking preview is not enough.
 */

/** Encode a scene as PNG in the page (lossless, so the input is exact). */
async function scenePng(page: Page, scene: Scene): Promise<Buffer> {
  const b64 = await page.evaluate(
    async ({ raw, width, height }) => {
      const bin = atob(raw);
      const px = new Uint8ClampedArray(bin.length);
      for (let i = 0; i < bin.length; i++) px[i] = bin.charCodeAt(i);
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      c.getContext('2d')!.putImageData(new ImageData(px, width, height), 0, 0);
      const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'));
      const u8 = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
      return btoa(s);
    },
    { raw: Buffer.from(scene.rgba.buffer, scene.rgba.byteOffset, scene.rgba.byteLength).toString('base64'), width: scene.width, height: scene.height },
  );
  return Buffer.from(b64, 'base64');
}

/** Decode an output file in the page and return all its pixels (straight RGBA). */
async function decode(page: Page, bytes: Buffer, mime: string) {
  const r = await page.evaluate(
    async ({ b64, mime }) => {
      const bin = atob(b64);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      // premultiplyAlpha: 'none' so colours of semi-transparent pixels are exact.
      const bmp = await createImageBitmap(new Blob([u8], { type: mime }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      const g = c.getContext('2d')!;
      g.drawImage(bmp, 0, 0);
      const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
      let s = '';
      for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode(...d.subarray(i, i + 0x8000));
      return { width: bmp.width, height: bmp.height, rgba: btoa(s) };
    },
    { b64: bytes.toString('base64'), mime },
  );
  return { width: r.width, height: r.height, rgba: new Uint8ClampedArray(Buffer.from(r.rgba, 'base64')) };
}

async function removeBackground(page: Page, scene: Scene, name: string, target: 'png' | 'jpeg', fill?: string) {
  const png = await scenePng(page, scene);
  await addFiles(page, [{ name, mimeType: 'image/png', buffer: png }]);
  await page.getByTestId('target').selectOption(target);
  await page.getByTestId('remove-bg').check();
  if (fill) await page.getByTestId('background').fill(fill);
  return png;
}

const px = (d: Uint8ClampedArray, w: number, x: number, y: number) => [...d.slice((y * w + x) * 4, (y * w + x) * 4 + 4)];

test.describe('photo of a person', () => {
  test.slow(); // the model runs in plain JavaScript; slower on emulated phones

  test('a dark-coated person on a dark rainy street is cut out cleanly (regression)', async ({ page }) => {
    const errors = await open(page);
    const requests: string[] = [];
    page.on('request', (r) => requests.push(r.url()));
    const scene = rainyStreet();
    await removeBackground(page, scene, 'street.png', 'png');
    const { name, bytes, card } = await convertAndDownload(page);

    expect(name).toBe('street.png');
    expect(sniff(bytes).formatId).toBe('png');
    const out = await decode(page, bytes, 'image/png');
    // Same size and alignment as the input.
    expect([out.width, out.height]).toEqual([scene.width, scene.height]);

    const s = score(scene, out.rgba);
    // Before the fix only ~5% of the person survived (the dark coat matched
    // the dark street) and street lights were left floating.
    expect(s.subjectKept).toBeGreaterThan(0.9);
    expect(s.backgroundLeft).toBeLessThan(0.08);
    expect(s.iou).toBeGreaterThan(0.65);

    // Dark clothing in the middle of the coat: kept, fully opaque.
    expect(px(out.rgba, out.width, 333, 450)[3]).toBe(255);
    // Light skin on the face: kept.
    expect(px(out.rgba, out.width, 333, 280)[3]).toBe(255);
    // Street-light glows, windows and corners: transparent, not black.
    for (const [x, y] of [[90, 180], [560, 150], [5, 5], [634, 794], [40, 300]] as const) {
      expect(px(out.rgba, out.width, x, y)[3], `alpha at ${x},${y}`).toBe(0);
    }
    // The subject's colours are the original ones wherever it is opaque.
    let checked = 0;
    for (let i = 0; i < scene.subject.length; i += 97) {
      if (out.rgba[i * 4 + 3] !== 255) continue;
      expect([...out.rgba.slice(i * 4, i * 4 + 3)]).toEqual([...scene.rgba.slice(i * 4, i * 4 + 3)]);
      checked++;
    }
    expect(checked).toBeGreaterThan(200);

    // The model is served by this site: no request goes anywhere else.
    const origin = new URL(page.url()).origin;
    expect(requests.filter((u) => !u.startsWith(origin) && !u.startsWith('blob:') && !u.startsWith('data:'))).toEqual([]);
    expect(requests.some((u) => u.endsWith('/assets/models/selfie_segmentation.tflite'))).toBe(true);
    await expect(card.getByTestId('status')).toContainText('Converted to PNG');
    expect(errors).toEqual([]);
  });

  test('saved as JPEG, the removed background is filled with the chosen colour', async ({ page }) => {
    await open(page);
    const scene = rainyStreet(320, 400);
    await removeBackground(page, scene, 'street.png', 'jpeg', '#00ff00');
    const { bytes, card } = await convertAndDownload(page);
    expect(sniff(bytes).formatId).toBe('jpeg');
    const out = await decode(page, bytes, 'image/jpeg');
    expect([out.width, out.height]).toEqual([320, 400]);
    const near = (a: number[], b: number[], tol: number) => b.every((v, i) => Math.abs(a[i]! - v) <= tol);
    // Background (corner, street light): the fill colour, never black.
    for (const [x, y] of [[3, 3], [45, 90], [316, 396]] as const) {
      expect(near(px(out.rgba, 320, x, y), [0, 255, 0, 255], 12), `fill at ${x},${y}`).toBe(true);
    }
    // The dark coat keeps its own colour.
    const coat = px(out.rgba, 320, 166, 225);
    const original = px(scene.rgba, 320, 166, 225);
    expect(near(coat, original, 14)).toBe(true);
    await expect(card).toContainText('The background was replaced with #00ff00');
  });
});

test('a product with a soft shadow on white: background transparent, shadow kept as a see-through shadow', async ({ page }) => {
  await open(page);
  const scene = productWithShadow();
  await removeBackground(page, scene, 'product.png', 'png');
  const { bytes, card } = await convertAndDownload(page);
  const out = await decode(page, bytes, 'image/png');
  expect(score(scene, out.rgba).subjectKept).toBeGreaterThan(0.99);
  expect(px(out.rgba, 240, 5, 5)[3]).toBe(0);
  expect(px(out.rgba, 240, 120, 95)).toEqual(px(scene.rgba, 240, 120, 95)); // product untouched
  const shadow = px(out.rgba, 240, 128, 155);
  expect(shadow[3]).toBeGreaterThan(40); // the shadow is still there...
  expect(shadow[3]).toBeLessThan(200); // ...and see-through
  expect(Math.max(shadow[0]!, shadow[1]!, shadow[2]!)).toBeLessThan(10); // as a dark shadow, not grey paint
  await expect(card.locator('.msg')).toHaveCount(0);
});

test('a light subject on a dark backdrop keeps clean edges with no dark fringe', async ({ page }) => {
  await open(page);
  const scene = lightOnDark();
  await removeBackground(page, scene, 'mug.png', 'png');
  const { bytes } = await convertAndDownload(page);
  const out = await decode(page, bytes, 'image/png');
  const s = score(scene, out.rgba);
  expect(s.subjectKept).toBeGreaterThan(0.98);
  expect(s.backgroundLeft).toBeLessThan(0.01);
  // Every visible outline pixel has the subject's light colour: composited
  // onto any new background there's no dark ring left from the old one.
  for (let i = 0; i < scene.subject.length; i++) {
    const a = out.rgba[i * 4 + 3]!;
    if (a > 0 && a < 255) expect(out.rgba[i * 4 + 1]!, `edge pixel ${i}`).toBeGreaterThan(180);
  }
});

test('a dark subject on a dark backdrop with no person is refused, not damaged', async ({ page }) => {
  await open(page);
  await removeBackground(page, darkOnDark(), 'dark.png', 'png');
  await page.getByTestId('convert').click();
  const card = page.getByTestId('file-card');
  await expect(card).toHaveAttribute('data-status', 'error', { timeout: 45_000 });
  await expect(card).toContainText("Couldn't find a background to remove");
  await expect(card).toContainText('Nothing was changed');
  await expect(card.getByTestId('download')).toBeHidden();
});
