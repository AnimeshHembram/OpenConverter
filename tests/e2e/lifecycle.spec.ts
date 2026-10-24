import { expect, test, type Page } from '@playwright/test';
import { addFiles, installDecodeGate, makeImage, open } from './helpers';

/**
 * Lifecycle and resource-management tests: device pixel limits, page
 * hide/restore, removing or cancelling during a conversion, and checking
 * that every ImageBitmap and canvas the converter creates is released.
 */

test('the pixel limit follows the device profile', async ({ page }, info) => {
  await open(page);
  const policy = await page.evaluate(() => (window as any).openconvert.pixelPolicy as { maxPixels: number });
  const expected = info.project.name.startsWith('mobile') ? 24_000_000 : 50_000_000;
  if (info.project.name === 'mobile-webkit') {
    expect(policy.maxPixels).toBe(16_777_216); // iPhone emulation
  } else {
    expect(policy.maxPixels).toBe(expected);
  }
});

test('an image whose header is too large is rejected before decoding, with an explanation', async ({ page }) => {
  await open(page);
  // A PNG signature and IHDR claiming 15000 x 15000 (225 MP). No pixel data.
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(header);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(15000, 16);
  header.writeUInt32BE(15000, 20);
  await addFiles(page, [{ name: 'huge.png', mimeType: 'image/png', buffer: header }]);
  const card = page.getByTestId('file-card').first();
  await expect(card).toHaveAttribute('data-status', 'error');
  await expect(card).toContainText('This image is 15000 × 15000 (225.0 MP)');
  await expect(card).toContainText('Resize it first');
  await expect(page.getByTestId('convert')).toBeDisabled();
});

test('previews and results survive the page being hidden and restored (back/forward cache)', async ({ page }) => {
  // Playwright's Chromium disables the real back/forward cache, so this
  // dispatches the same pagehide/pageshow events the browser sends.
  await open(page);
  const png = await makeImage(page, { mime: 'image/png', width: 24, height: 24 });
  await addFiles(page, [{ name: 'keep.png', mimeType: 'image/png', buffer: png }]);
  await page.getByTestId('target').selectOption('jpeg');
  await page.getByTestId('convert').click();
  await expect(page.locator('[data-status=done]')).toHaveCount(1);
  const before = await page.evaluate(() => (window as any).openconvert.controller.liveObjectUrls);

  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });

  expect(await page.evaluate(() => (window as any).openconvert.controller.liveObjectUrls)).toBe(before);
  // Every preview URL still loads.
  const loaded = await page.evaluate(async () => {
    const urls = [...document.querySelectorAll<HTMLImageElement>('[data-testid=file-card] img')].map((i) => i.src).filter(Boolean);
    const results = await Promise.all(
      urls.map((u) => new Promise<boolean>((res) => { const im = new Image(); im.onload = () => res(true); im.onerror = () => res(false); im.src = u; })),
    );
    return { count: urls.length, ok: results.every(Boolean) };
  });
  expect(loaded).toEqual({ count: 2, ok: true });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download').first().click()]);
  expect(dl.suggestedFilename()).toBe('keep.jpg');
});

test('removing a file while it is converting drops it cleanly and the batch continues', async ({ page }) => {
  const errors = await open(page);
  const png = await makeImage(page, { mime: 'image/png', width: 300, height: 200 });
  await addFiles(page, [
    { name: 'one.png', mimeType: 'image/png', buffer: png },
    { name: 'two.png', mimeType: 'image/png', buffer: png },
  ]);
  const gate = await installDecodeGate(page);
  await page.getByTestId('target').selectOption('bmp');
  await gate.close();
  await page.getByTestId('convert').click();
  await gate.blocked(); // "one.png" is now mid-conversion, paused in decoding
  const first = page.getByTestId('file-card').first();
  await expect(first).toHaveAttribute('data-status', 'converting');
  await first.getByTestId('remove').click();
  await expect(page.getByTestId('file-card')).toHaveCount(1);
  await gate.open();
  await expect(page.getByTestId('file-card').first()).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
  await expect(page.getByTestId('file-card').first()).toContainText('two.png');
  await expect(page.getByTestId('cancel')).toBeHidden();
  expect(await page.evaluate(() => (window as any).openconvert.controller.liveObjectUrls)).toBe(2);
  expect(errors).toEqual([]);
});

test('cancel stops the batch: queued files return to ready and nothing is marked as failed', async ({ page }) => {
  await open(page);
  const png = await makeImage(page, { mime: 'image/png', width: 300, height: 200 });
  await addFiles(page, ['a', 'b', 'c'].map((n) => ({ name: `${n}.png`, mimeType: 'image/png', buffer: png })));
  const gate = await installDecodeGate(page);
  await page.getByTestId('target').selectOption('bmp');
  await gate.close();
  await page.getByTestId('convert').click();
  await gate.blocked();
  await expect(page.getByTestId('file-card').first()).toHaveAttribute('data-status', 'converting');
  await page.getByTestId('cancel').click();
  await gate.open();
  await expect(page.getByTestId('notice')).toHaveText('Conversion cancelled. 0 files converted.');
  await expect(page.locator('[data-status=error]')).toHaveCount(0);
  await expect(page.locator('[data-status=ready]')).toHaveCount(3);
  await expect(page.getByTestId('convert')).toBeEnabled();
});

/** Count ImageBitmaps and canvases created after `arm()` and check they're released. */
async function instrument(page: Page) {
  await page.evaluate(() => {
    const w = window as any;
    w.__res = { armed: false, bitmaps: [] as ImageBitmap[], closed: new Set<ImageBitmap>(), canvases: [] as HTMLCanvasElement[] };
    const origCIB = window.createImageBitmap.bind(window);
    (window as any).createImageBitmap = async (...args: unknown[]) => {
      const bm = await (origCIB as any)(...args);
      if (w.__res.armed) w.__res.bitmaps.push(bm);
      return bm;
    };
    const origClose = ImageBitmap.prototype.close;
    ImageBitmap.prototype.close = function (this: ImageBitmap) { w.__res.closed.add(this); return origClose.call(this); };
    const origCreate = document.createElement.bind(document);
    (document as any).createElement = (tag: string, opts?: ElementCreationOptions) => {
      const el = origCreate(tag, opts);
      if (w.__res.armed && tag.toLowerCase() === 'canvas') w.__res.canvases.push(el);
      return el;
    };
  });
  return {
    arm: () => page.evaluate(() => { (window as any).__res.armed = true; }),
    report: () =>
      page.evaluate(() => {
        const r = (window as any).__res;
        return {
          bitmaps: r.bitmaps.length,
          unclosedBitmaps: r.bitmaps.filter((b: ImageBitmap) => !r.closed.has(b)).length,
          canvases: r.canvases.length,
          unreleasedCanvases: r.canvases.filter((c: HTMLCanvasElement) => c.width * c.height > 0).length,
        };
      }),
  };
}

test('bitmaps and canvases are released after success, failure and cancellation', async ({ page }) => {
  await open(page, '?noNative=webp');
  const small = await makeImage(page, { mime: 'image/png', width: 64, height: 64, transparentHalf: true });
  const res = await instrument(page);
  const gate = await installDecodeGate(page); // wraps the instrumented decoder
  await res.arm();

  // Success: PNG → JPEG (exact transparency scan) and → BMP.
  await addFiles(page, [{ name: 's.png', mimeType: 'image/png', buffer: small }]);
  for (const t of ['jpeg', 'bmp']) {
    await page.getByTestId('target').selectOption(t);
    await page.getByTestId('convert').click();
    await expect(page.locator('[data-status=done]')).toHaveCount(1);
  }
  // Failure: the WASM WebP encoder can't load.
  await page.route('**/*.wasm', (r) => r.abort());
  await page.getByTestId('target').selectOption('webp');
  await page.getByTestId('convert').click();
  await expect(page.locator('[data-status=error]')).toHaveCount(1);
  await page.unroute('**/*.wasm');
  // Cancellation mid-batch.
  await page.getByTestId('clear').click();
  await addFiles(page, ['x', 'y'].map((n) => ({ name: `${n}.png`, mimeType: 'image/png', buffer: small })));
  await page.getByTestId('target').selectOption('bmp');
  await gate.close();
  await page.getByTestId('convert').click();
  await gate.blocked();
  await page.getByTestId('cancel').click();
  await gate.open();
  await expect(page.getByTestId('notice')).toHaveText('Conversion cancelled. 0 files converted.');

  const r = await res.report();
  expect(r.canvases).toBeGreaterThan(0);
  expect(r).toMatchObject({ unclosedBitmaps: 0, unreleasedCanvases: 0 });
  await page.getByTestId('clear').click();
  expect(await page.evaluate(() => (window as any).openconvert.controller.liveObjectUrls)).toBe(0);
});
