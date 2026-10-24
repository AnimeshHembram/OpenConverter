import { expect, test, type Page } from '@playwright/test';
import { addFiles, makeImage, open } from './helpers';

/** Light/dark theme: defaults, switching, persistence, and robustness. */

const bodyBg = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme);
const WHITE = 'rgb(255, 255, 255)';
const NEAR_BLACK = 'rgb(10, 10, 10)';

test('the header shows the name as text only, and an accessible theme switch', async ({ page }) => {
  await open(page);
  const brand = page.locator('.site-header .brand');
  await expect(brand).toHaveText('OpenConverter');
  await expect(page.locator('.site-header img, .site-header .brand svg')).toHaveCount(0);
  await expect(page.getByRole('switch', { name: 'Dark theme' })).toBeVisible();
});

for (const scheme of ['light', 'dark'] as const) {
  test(`with no saved choice, follows the system ${scheme} preference`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await open(page);
    expect(await theme(page)).toBe(scheme);
    await expect(page.getByTestId('theme-switch')).toHaveAttribute('aria-checked', String(scheme === 'dark'));
    expect(await bodyBg(page)).toBe(scheme === 'dark' ? NEAR_BLACK : WHITE);
  });
}

test('the switch toggles the whole app and the choice survives a reload', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await open(page);
  const png = await makeImage(page, { mime: 'image/png', width: 8, height: 8 });
  await addFiles(page, [{ name: 'a.png', mimeType: 'image/png', buffer: png }]);
  const sw = page.getByTestId('theme-switch');

  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  expect(await theme(page)).toBe('dark');
  // Colours fade over a short transition; wait for them to settle.
  await expect.poll(() => bodyBg(page)).toBe(NEAR_BLACK);
  // Theme reaches the rest of the app: the file list and native controls.
  await expect.poll(() => page.locator('.workspace').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(NEAR_BLACK);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('dark');

  await page.reload();
  await expect(page.locator('#app')).not.toHaveAttribute('aria-busy');
  expect(await theme(page)).toBe('dark');
  await expect(page.getByTestId('theme-switch')).toHaveAttribute('aria-checked', 'true');

  await page.getByTestId('theme-switch').click();
  await page.reload();
  expect(await theme(page)).toBe('light');
});

test('the switch works from the keyboard', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Keyboard interaction is a desktop concern.');
  await page.emulateMedia({ colorScheme: 'light' });
  await open(page);
  const sw = page.getByTestId('theme-switch');
  await sw.focus();
  await page.keyboard.press('Space');
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Enter');
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  // Visible focus indicator on the switch's track.
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(sw).toBeFocused();
  const outline = await sw.locator('.theme-switch-track').evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).not.toBe('none');
});

test('a saved choice beats the system preference, and system changes are ignored after choosing', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await open(page);
  await page.emulateMedia({ colorScheme: 'dark' }); // no choice yet: follows live
  await expect.poll(() => theme(page)).toBe('dark');
  await page.getByTestId('theme-switch').click(); // choose light
  expect(await theme(page)).toBe('light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.emulateMedia({ colorScheme: 'dark' });
  expect(await theme(page)).toBe('light');
  await page.reload();
  expect(await theme(page)).toBe('light');
});

test('the theme is applied before the app script runs (no flash of the wrong theme)', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  // Block the app bundle entirely: only the tiny pre-paint script runs.
  await page.route(/\/assets\/index-[^/]+\.js$/, (r) => r.abort());
  await page.goto('/');
  expect(await theme(page)).toBe('dark');
  expect(await bodyBg(page)).toBe(NEAR_BLACK);
});

test('blocked storage does not break the page or the switch', async ({ page }) => {
  await page.addInitScript(() => {
    const fail = () => { throw new DOMException('blocked', 'SecurityError'); };
    Object.defineProperty(window, 'localStorage', { get: fail, configurable: true });
  });
  await page.emulateMedia({ colorScheme: 'light' });
  const errors = await open(page);
  await page.getByTestId('theme-switch').click();
  expect(await theme(page)).toBe('dark');
  await expect.poll(() => bodyBg(page)).toBe(NEAR_BLACK);
  expect(errors).toEqual([]);
});
