import { expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

/** Shared helpers for the end-to-end suites. */

export interface MakeOpts {
  mime: string;
  width: number;
  height: number;
  /** Left half opaque red, right half fully transparent. */
  transparentHalf?: boolean;
}

/** Draw a test image with canvas in the page and return its encoded bytes. */
export async function makeImage(page: Page, o: MakeOpts): Promise<Buffer> {
  const arr = await page.evaluate(async ({ mime, width, height, transparentHalf }) => {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    const g = c.getContext('2d')!;
    g.fillStyle = 'rgb(220, 30, 30)';
    g.fillRect(0, 0, transparentHalf ? width / 2 : width, height);
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), mime, 0.92));
    return [...new Uint8Array(await blob.arrayBuffer())];
  }, o);
  return Buffer.from(arr);
}

/**
 * Large opaque red PNG with thin fully-transparent features: one row at
 * y = height/2 and one column at x = 0. A 256-pixel downscaled probe can't
 * see them, which is how the original transparency defects slipped through.
 */
export async function makeThinTransparencyPng(page: Page, size = 2000): Promise<Buffer> {
  const arr = await page.evaluate(async (size) => {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d')!;
    g.fillStyle = 'rgb(220, 30, 30)';
    g.fillRect(0, 0, size, size);
    g.clearRect(0, size / 2, size, 1);
    g.clearRect(0, 0, 1, size);
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/png'));
    return [...new Uint8Array(await blob.arrayBuffer())];
  }, size);
  return Buffer.from(arr);
}

/**
 * Decode image bytes in the page and return its size plus the RGBA values at
 * the given points. Only use for small encoded files (JPEG, PNG, WebP):
 * the bytes are copied through the Playwright bridge.
 */
export async function pixelsAt(page: Page, bytes: Buffer, mime: string, points: [number, number][]) {
  return page.evaluate(
    async ({ b64, mime, points }) => {
      const bin = atob(b64);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const bmp = await createImageBitmap(new Blob([u8], { type: mime }));
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      const g = c.getContext('2d')!;
      g.drawImage(bmp, 0, 0);
      return {
        width: bmp.width,
        height: bmp.height,
        rgba: points.map(([x, y]) => [...g.getImageData(x, y, 1, 1).data]),
      };
    },
    { b64: bytes.toString('base64'), mime, points },
  );
}

export async function pixelAt(page: Page, bytes: Buffer, mime: string, x: number, y: number) {
  const r = await pixelsAt(page, bytes, mime, [[x, y]]);
  return { width: r.width, height: r.height, rgba: r.rgba[0]! };
}

/** Navigate and collect unexpected console errors for the test to assert on. */
export async function open(page: Page, query = '', path = '/') {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('[OpenConvert]')) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${path}${query}`);
  await expect(page.getByTestId('target')).toBeVisible();
  return errors;
}

export async function addFiles(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  await page.getByTestId('file-input').setInputFiles(files);
  await expect(page.getByTestId('file-card')).toHaveCount(files.length);
}

export async function convertAndDownload(page: Page, cardIndex = 0) {
  await page.getByTestId('convert').click();
  const card = page.getByTestId('file-card').nth(cardIndex);
  await expect(card).toHaveAttribute('data-status', 'done', { timeout: 45_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), card.getByTestId('download').click()]);
  const path = await download.path();
  return { name: download.suggestedFilename(), bytes: await readFile(path!), card };
}

/** Read one pixel from a BMP file's bytes (24- or 32-bit, bottom-up). Returns RGBA. */
export function bmpPixel(bytes: Buffer, x: number, y: number): number[] {
  const offset = bytes.readUInt32LE(10);
  const width = bytes.readInt32LE(18);
  const height = bytes.readInt32LE(22);
  const bpp = bytes.readUInt16LE(28) / 8;
  const rowSize = Math.ceil((width * bpp) / 4) * 4;
  const row = height > 0 ? height - 1 - y : y;
  const p = offset + row * rowSize + x * bpp;
  return [bytes[p + 2]!, bytes[p + 1]!, bytes[p]!, bpp === 4 ? bytes[p + 3]! : 255];
}
