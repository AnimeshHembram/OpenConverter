import { expect, test } from '@playwright/test';
import { addFiles, makeImage, open } from './helpers';

/** Upload zone states and layout around it. */

test('empty state: centred upload zone with the real formats and limits, no settings yet', async ({ page }) => {
  await open(page);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Convert your images. Simply.');
  const zone = page.getByTestId('dropzone');
  await expect(zone).toContainText('Drop your images here');
  await expect(zone).toContainText('or browse files');
  await expect(zone).toContainText('PNG, JPEG, WebP or BMP · up to 100 MB per file · up to 200 files');
  await expect(page.getByText('Your files are converted on this device and never uploaded.')).toBeVisible();
  await expect(page.getByTestId('target')).toBeHidden();
  await expect(page.getByTestId('file-list')).toBeHidden();

  // Horizontally centred in the viewport.
  const box = (await zone.boundingBox())!;
  const vw = page.viewportSize()!.width;
  expect(Math.abs(box.x + box.width / 2 - vw / 2)).toBeLessThan(2);
});

test('clicking anywhere on the zone opens the native file picker', async ({ page }) => {
  await open(page);
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('dropzone').click({ position: { x: 30, y: 30 } });
  expect((await chooser).isMultiple()).toBe(true);
});

test('drag-over highlights the zone; dropping text instead of files explains the problem', async ({ page }) => {
  await open(page);
  const zone = page.getByTestId('dropzone');
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'a.png', { type: 'image/png' }));
    window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect(zone).toHaveClass(/is-dragover/);
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'hello');
    document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect(zone).not.toHaveClass(/is-dragover/);
  await expect(zone).toHaveClass(/is-error/);
  await expect(zone).toContainText('Nothing to add. Drop image files, not text or links.');
  await expect(page.getByTestId('file-card')).toHaveCount(0);
});

test('with files: the zone becomes compact, settings and the list appear, and clearing restores the empty state', async ({ page }) => {
  await open(page);
  const zone = page.getByTestId('dropzone');
  const before = (await zone.boundingBox())!.height;
  const png = await makeImage(page, { mime: 'image/png', width: 8, height: 8 });
  await addFiles(page, [{ name: 'a.png', mimeType: 'image/png', buffer: png }]);
  await expect(page.locator('body')).toHaveClass(/has-files/);
  expect((await zone.boundingBox())!.height).toBeLessThan(before);
  await expect(page.getByTestId('target')).toBeVisible();
  await expect(page.locator('#files-title')).toHaveText('1 file');
  await expect(page.getByTestId('download-all')).toBeHidden(); // nothing converted yet

  await page.getByTestId('clear').click();
  await expect(page.locator('body')).not.toHaveClass(/has-files/);
  await expect(page.getByTestId('target')).toBeHidden();
});

test('a failed file is shown as not converted with a text-labelled error', async ({ page }) => {
  await open(page);
  await addFiles(page, [{ name: 'bad.png', mimeType: 'image/png', buffer: Buffer.from('nope') }]);
  const row = page.getByTestId('file-card').first();
  await expect(row).toHaveAttribute('data-status', 'error');
  await expect(row.getByTestId('status')).toHaveText('Not converted');
  await expect(row.locator('.msg-error')).toHaveText(/^Error: This doesn't look like/);
  await expect(row.getByTestId('download')).toBeHidden();
});

test('the loading hint is replaced as soon as the app starts', async ({ page }) => {
  await open(page);
  await expect(page.locator('.boot-hint')).toHaveCount(0);
});

test('opening index.html straight from disk explains how to start the app', async ({ page }) => {
  const { pathToFileURL } = await import('node:url');
  const { resolve } = await import('node:path');
  await page.goto(pathToFileURL(resolve('index.html')).href);
  await expect(page.locator('.boot-hint')).toContainText('npm start');
});
