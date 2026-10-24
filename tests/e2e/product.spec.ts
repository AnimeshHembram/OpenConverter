import { expect, test, type Page } from '@playwright/test';
import { addFiles, convertAndDownload, makeImage, open } from './helpers';

/**
 * Product-level UI checks: text contrast in both themes, the preview dialog,
 * the results summary, the pinned action bar, and browser-chrome colour.
 */

/**
 * WCAG 2.x contrast for every visible text node: text colour against the
 * nearest opaque background. 4.5:1 for normal text, 3:1 for large text
 * (≥ 24px, or ≥ 18.66px bold). Disabled controls are exempt under WCAG.
 */
async function contrastFailures(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const parse = (c: string) => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const [r, g, b, a = 1] = m[1]!.split(/[ ,/]+/).filter(Boolean).map(Number);
      return { r: r!, g: g!, b: b!, a };
    };
    const lum = ({ r, g, b }: { r: number; g: number; b: number }) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const bgOf = (el: Element | null): { r: number; g: number; b: number } => {
      for (let e = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (c && c.a >= 0.99) return c;
      }
      return { r: 255, g: 255, b: 255 };
    };
    const fails: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement!;
      if (!n.textContent?.trim() || el.closest('[hidden], .visually-hidden, :disabled, noscript, dialog:not([open])')) continue;
      const rect = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (!rect.width || !rect.height || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
      const fg = parse(cs.color)!;
      const bg = bgOf(el);
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a) as [number, number];
      const ratio = (hi + 0.05) / (lo + 0.05);
      const size = parseFloat(cs.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5)) fails.push(`${ratio.toFixed(2)}:1 "${n.textContent.trim().slice(0, 40)}" (${cs.color} on rgb(${bg.r}, ${bg.g}, ${bg.b}))`);
    }
    return fails;
  });
}

for (const scheme of ['light', 'dark'] as const) {
  test(`all visible text meets WCAG AA contrast in the ${scheme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await open(page);
    expect(await contrastFailures(page), 'empty state').toEqual([]);
    const png = await makeImage(page, { mime: 'image/png', width: 40, height: 20, transparentHalf: true });
    await addFiles(page, [
      { name: 'a.png', mimeType: 'image/png', buffer: png },
      { name: 'bad.png', mimeType: 'image/png', buffer: Buffer.from('nope') },
    ]);
    expect(await contrastFailures(page), 'files added').toEqual([]);
    await page.getByTestId('target').selectOption('jpeg');
    await page.getByTestId('convert').click();
    await expect(page.locator('[data-status=done]')).toHaveCount(1);
    expect(await contrastFailures(page), 'converted, with a note and an error').toEqual([]);
    await page.getByTestId('preview').first().click();
    expect(await contrastFailures(page), 'preview dialog').toEqual([]);
  });
}

test('the preview dialog shows original and converted side by side, and is keyboard friendly', async ({ page }) => {
  await open(page);
  const png = await makeImage(page, { mime: 'image/png', width: 40, height: 20 });
  await addFiles(page, [{ name: 'pic.png', mimeType: 'image/png', buffer: png }]);
  const dialog = page.getByTestId('preview-dialog');
  const previewBtn = page.getByRole('button', { name: 'Preview pic.png' });

  // Before conversion: original only.
  await previewBtn.click();
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'pic.png' })).toBeVisible();
  await expect(dialog.getByRole('img', { name: 'Original: pic.png' })).toBeVisible();
  await expect(dialog).toContainText('Not converted yet');
  await expect(page.getByTestId('preview-close')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(previewBtn).toBeFocused(); // focus returns to the opener

  // After conversion: both, with sizes, and a working download.
  await page.getByTestId('target').selectOption('webp');
  await page.getByTestId('convert').click();
  await expect(page.locator('[data-status=done]')).toHaveCount(1);
  await previewBtn.click();
  await expect(dialog.getByRole('img', { name: 'Converted: pic.webp' })).toBeVisible();
  await expect(dialog).toContainText('PNG · 40 × 20');
  await expect(dialog).toContainText('WebP · 40 × 20');
  const [dl] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Download pic.webp' }).click()]);
  expect(dl.suggestedFilename()).toBe('pic.webp');
  await page.getByTestId('preview-close').click();
  await expect(dialog).toBeHidden();

  // Clicking a thumbnail opens it too; clicking the backdrop closes it.
  await page.getByTestId('file-card').first().locator('.previews').click();
  await expect(dialog).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(dialog).toBeHidden();
});

test('preview images live outside the file rows (rows keep exactly their two thumbnails)', async ({ page }) => {
  await open(page);
  const png = await makeImage(page, { mime: 'image/png', width: 10, height: 10 });
  await addFiles(page, [{ name: 'x.png', mimeType: 'image/png', buffer: png }]);
  await page.getByTestId('target').selectOption('png');
  await convertAndDownload(page);
  await page.getByTestId('preview').first().click();
  await expect(page.locator('[data-testid=file-card] img')).toHaveCount(2);
});

test('the list header summarises results', async ({ page }) => {
  await open(page);
  const png = await makeImage(page, { mime: 'image/png', width: 10, height: 10 });
  await addFiles(page, [
    { name: 'ok.png', mimeType: 'image/png', buffer: png },
    { name: 'bad.png', mimeType: 'image/png', buffer: Buffer.from('nope') },
  ]);
  await expect(page.locator('#files-title')).toHaveText('2 files');
  await expect(page.getByTestId('list-summary')).toHaveText('1 not converted');
  await page.getByTestId('target').selectOption('jpeg');
  await page.getByTestId('convert').click();
  await expect(page.getByTestId('list-summary')).toHaveText('1 converted · 1 not converted');
  // Changing settings makes the result stale: it's no longer counted.
  await page.getByTestId('target').selectOption('png');
  await expect(page.getByTestId('list-summary')).toHaveText('1 not converted');
});

test('with a long list, the action bar stays on screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await open(page);
  const png = await makeImage(page, { mime: 'image/png', width: 10, height: 10 });
  await addFiles(page, Array.from({ length: 12 }, (_, i) => ({ name: `img-${i + 1}.png`, mimeType: 'image/png', buffer: png })));
  await page.getByTestId('file-card').nth(3).scrollIntoViewIfNeeded();
  const bar = (await page.locator('.actionbar').boundingBox())!;
  expect(bar.y + bar.height).toBeLessThanOrEqual(700 + 1);
  expect(bar.y).toBeGreaterThan(0);
  await expect(page.getByTestId('convert')).toBeInViewport();
});

test("the browser bar colour follows the chosen theme, not just the system's", async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await open(page);
  const colours = () => page.locator('meta[name="theme-color"]').evaluateAll((ms) => ms.map((m) => m.getAttribute('content')));
  expect(await colours()).toEqual(['#ffffff', '#ffffff']);
  await page.getByTestId('theme-switch').click();
  expect(await colours()).toEqual(['#0a0a0a', '#0a0a0a']);
  await page.reload();
  expect(await colours()).toEqual(['#0a0a0a', '#0a0a0a']);
});

test('while converting, Cancel takes the place of Convert and downloads wait', async ({ page }) => {
  await open(page);
  const { installDecodeGate } = await import('./helpers');
  const png = await makeImage(page, { mime: 'image/png', width: 20, height: 20 });
  await addFiles(page, [{ name: 'a.png', mimeType: 'image/png', buffer: png }, { name: 'b.png', mimeType: 'image/png', buffer: png }]);
  await page.getByTestId('target').selectOption('jpeg');
  await page.getByTestId('convert').click();
  await expect(page.locator('[data-status=done]')).toHaveCount(2);
  await expect(page.getByTestId('download-all')).toBeVisible();

  const gate = await installDecodeGate(page);
  await page.getByTestId('target').selectOption('png');
  await gate.close();
  await page.getByTestId('convert').click();
  await gate.blocked();
  await expect(page.getByTestId('cancel')).toBeVisible();
  await expect(page.getByTestId('convert')).toBeHidden();
  await expect(page.getByTestId('download-all')).toBeHidden();
  await gate.open();
  await expect(page.getByTestId('cancel')).toBeHidden();
  await expect(page.getByTestId('convert')).toBeVisible();
  await expect(page.getByTestId('download-all')).toHaveText('Download all (2) as ZIP');
});

test('preview images are shown whole, never cropped, whatever their shape', async ({ page }) => {
  await open(page);
  const tall = await makeImage(page, { mime: 'image/png', width: 100, height: 400 });
  const wide = await makeImage(page, { mime: 'image/png', width: 800, height: 100 });
  await addFiles(page, [{ name: 'tall.png', mimeType: 'image/png', buffer: tall }, { name: 'wide.png', mimeType: 'image/png', buffer: wide }]);
  for (const i of [0, 1]) {
    await page.getByTestId('preview').nth(i).click();
    const img = page.getByTestId('preview-dialog').locator('.pd-image img').first();
    await expect(img).toBeVisible();
    const fit = await img.evaluate((el: HTMLImageElement) => {
      const box = el.getBoundingClientRect();
      const frame = el.parentElement!.getBoundingClientRect();
      // Rendered content size under object-fit: contain.
      const scale = Math.min(box.width / el.naturalWidth, box.height / el.naturalHeight);
      return {
        inside: box.top >= frame.top - 0.5 && box.bottom <= frame.bottom + 0.5 && box.left >= frame.left - 0.5 && box.right <= frame.right + 0.5,
        contentW: el.naturalWidth * scale,
        contentH: el.naturalHeight * scale,
        frameW: frame.width,
        frameH: frame.height,
      };
    });
    expect(fit.inside).toBe(true);
    expect(fit.contentW).toBeLessThanOrEqual(fit.frameW + 0.5);
    expect(fit.contentH).toBeLessThanOrEqual(fit.frameH + 0.5);
    await page.keyboard.press('Escape');
  }
});
