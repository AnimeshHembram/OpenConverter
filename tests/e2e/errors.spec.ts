import { expect, test } from '@playwright/test';
import { sniff } from '../../src/core/detect';
import { addFiles, convertAndDownload, makeImage, open } from './helpers';

test('a WebP encoder that fails to load gives a specific error, never a mislabelled file, and can be retried', async ({ page }) => {
  await open(page, '?noNative=webp');
  await page.route('**/*.wasm', (r) => r.abort('internetdisconnected'));
  const png = await makeImage(page, { mime: 'image/png', width: 20, height: 20 });
  await addFiles(page, [{ name: 'p.png', mimeType: 'image/png', buffer: png }]);
  await page.getByTestId('target').selectOption('webp');
  await page.getByTestId('convert').click();
  const card = page.getByTestId('file-card').first();
  await expect(card).toHaveAttribute('data-status', 'error', { timeout: 30_000 });
  await expect(card).toContainText("built-in WebP encoder couldn't be loaded");
  await expect(card.getByTestId('download')).toBeHidden();
  await expect(page.getByTestId('notice')).toContainText("1 file couldn't be converted");

  // Network restored: retrying the same file now succeeds.
  await page.unroute('**/*.wasm');
  const { name, bytes } = await convertAndDownload(page);
  expect(name).toBe('p.webp');
  expect(sniff(bytes).formatId).toBe('webp');
});
