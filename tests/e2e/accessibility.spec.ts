import { expect, test, type Page } from '@playwright/test';
import { addFiles, makeImage, open } from './helpers';

/**
 * Keyboard access, focus visibility, accessible names, live announcements,
 * and the non-file-picker ways of adding files (drag-and-drop, paste).
 */

test.skip(({ isMobile }) => isMobile, 'Keyboard tab order is a desktop concern; mobile projects run the rest of the suite.');

async function tabTo(page: Page, testId: string, max = 10) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate((id) => document.activeElement?.getAttribute('data-testid') === id, testId)) return i + 1;
  }
  throw new Error(`could not reach ${testId} with Tab`);
}

test('the file picker is reachable by keyboard, shows a visible focus ring, and opens from the keyboard', async ({ page, browserName }) => {
  await open(page);
  // From the top of the page the file picker is reached within the first
  // couple of Tab presses (after the skip link, where the browser tabs to links).
  expect(await tabTo(page, 'file-input', 3)).toBeLessThanOrEqual(2);
  await expect(page.getByTestId('file-input')).toBeFocused();

  const outline = await page.getByTestId('dropzone').evaluate((el) => {
    const cs = getComputedStyle(el);
    return { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) };
  });
  expect(outline.style).not.toBe('none');
  expect(outline.width).toBeGreaterThanOrEqual(2);

  // Space activates a focused file input in every engine; Chromium also accepts Enter.
  const keys = browserName === 'chromium' ? ['Space', 'Enter'] : ['Space'];
  for (const key of keys) {
    const chooser = page.waitForEvent('filechooser', { timeout: 5_000 });
    await page.keyboard.press(key);
    expect((await chooser).isMultiple()).toBe(true);
  }
});

test('the skip link moves past the header to the converter', async ({ page }) => {
  await open(page);
  await expect(page.getByRole('link', { name: 'Skip to converter' })).toHaveAttribute('href', '#main');
});

test('controls have accessible names and a logical tab order', async ({ page }) => {
  await open(page);
  await expect(page.getByLabel('Choose images or drop them here')).toHaveAttribute('type', 'file');
  await expect(page.getByRole('combobox', { name: 'Convert to' })).toBeVisible();
  await expect(page.getByRole('slider', { name: /Quality/ })).toBeVisible();
  await page.getByTestId('target').selectOption('jpeg');
  // Colour inputs have no implicit ARIA role; check the label association.
  await expect(page.getByLabel('Fill for transparent areas')).toHaveAttribute('type', 'color');

  await page.getByTestId('file-input').focus();
  expect(await tabTo(page, 'target')).toBe(1);
  expect(await tabTo(page, 'quality')).toBe(1);
  expect(await tabTo(page, 'background')).toBe(1);
});

test('status is announced through a live region and errors are not conveyed by colour alone', async ({ page }) => {
  await open(page);
  const live = page.getByRole('status');
  const png = await makeImage(page, { mime: 'image/png', width: 8, height: 8 });
  await addFiles(page, [
    { name: 'ok.png', mimeType: 'image/png', buffer: png },
    { name: 'bad.png', mimeType: 'image/png', buffer: Buffer.from('not an image') },
  ]);
  await expect(live).toHaveText("1 file can't be converted. See the details below.");
  await expect(page.getByTestId('file-card').nth(1).locator('.msg-error')).toHaveText(/^Error: /);

  await page.getByTestId('target').selectOption('png');
  await page.getByTestId('convert').click();
  await expect(live).toHaveText('1 file converted.');
  await expect(page.getByRole('img', { name: 'Converted: ok.png' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download ok.png' })).toBeVisible();
});

test('removing a file moves focus to the next Remove button, and Clear returns focus to the file picker', async ({ page }) => {
  await open(page);
  const png = await makeImage(page, { mime: 'image/png', width: 8, height: 8 });
  await addFiles(page, ['a', 'b', 'c'].map((n) => ({ name: `${n}.png`, mimeType: 'image/png', buffer: png })));
  await page.getByRole('button', { name: 'Remove a.png' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Remove b.png' })).toBeFocused();
  await page.getByRole('button', { name: 'Remove c.png' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Remove b.png' })).toBeFocused(); // last one: previous card
  await page.getByTestId('clear').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('file-input')).toBeFocused();
});

/** Dispatch a real drop/paste event carrying files built in the page. */
async function dispatchFiles(page: Page, kind: 'drop' | 'paste', files: { name: string; type: string; b64: string }[]) {
  await page.evaluate(({ kind, files }) => {
    const dt = new DataTransfer();
    for (const f of files) {
      const bin = atob(f.b64);
      const u8 = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
      dt.items.add(new File([u8], f.name, { type: f.type }));
    }
    if (kind === 'drop') {
      const zone = document.querySelector('[data-testid=dropzone]')!;
      zone.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
      zone.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      zone.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    } else {
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }
  }, { kind, files });
}

test('files can be added by drag-and-drop', async ({ page }) => {
  await open(page);
  const png = await makeImage(page, { mime: 'image/png', width: 10, height: 6 });
  await dispatchFiles(page, 'drop', [
    { name: 'dropped.png', type: 'image/png', b64: png.toString('base64') },
    { name: 'second.png', type: 'image/png', b64: png.toString('base64') },
  ]);
  await expect(page.getByTestId('file-card')).toHaveCount(2);
  await expect(page.getByTestId('file-card').first()).toContainText('PNG · 10 × 6');
  await expect(page.getByTestId('dropzone')).not.toHaveClass(/is-dragover/);
});

test('files can be added by pasting', async ({ page }) => {
  await open(page);
  const jpg = await makeImage(page, { mime: 'image/jpeg', width: 12, height: 9 });
  await dispatchFiles(page, 'paste', [{ name: 'image.jpg', type: 'image/jpeg', b64: jpg.toString('base64') }]);
  await expect(page.getByTestId('file-card')).toHaveCount(1);
  await expect(page.getByTestId('file-card').first()).toContainText('JPEG · 12 × 9');
});
