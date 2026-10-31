import { expect, test, type Page } from '@playwright/test';
import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { sniff } from '../../src/core/detect';
import { buildPdf, SAMPLE_TEXT_PAGES } from '../fixtures/pdfs';
import { addFiles, open, pixelsAt } from './helpers';

/**
 * Level 2, stage 2: PDF. Real PDFs are built with pdf-lib, converted through
 * the UI, and every download is opened and checked: images decoded, ZIPs
 * unpacked, Word files unzipped, PDFs parsed again.
 */

const card = (page: Page, name: string) => page.getByTestId('file-card').filter({ hasText: name });

async function convertRow(page: Page, name: string, target: string) {
  const row = card(page, name);
  await row.getByTestId('row-target').selectOption(target);
  await page.getByTestId('convert').click();
  await expect(row).toHaveAttribute('data-status', /done|error/, { timeout: 60_000 });
  await expect(row).toHaveAttribute('data-status', 'done');
  const [download] = await Promise.all([page.waitForEvent('download'), row.getByTestId('download').click()]);
  return { name: download.suggestedFilename(), bytes: await readFile((await download.path())!), row };
}

/** A "scan": a 300 dpi A4 page image (paper texture with dark lines), as a high-quality JPEG. */
async function scanJpeg(page: Page): Promise<Uint8Array> {
  const arr = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 2480;
    c.height = 3508;
    const g = c.getContext('2d')!;
    g.fillStyle = '#f4f1ea';
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#222';
    for (let y = 300; y < 3300; y += 70) g.fillRect(250, y, 1500 + ((y * 7) % 480), 18);
    // Scanner grain: real scans are noisy, which is what makes them large.
    const img = g.getImageData(0, 0, c.width, c.height);
    let seed = 7;
    for (let i = 0; i < img.data.length; i += 4) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      const n = ((seed >>> 24) % 25) - 12;
      img.data[i] = img.data[i]! + n;
      img.data[i + 1] = img.data[i + 1]! + n;
      img.data[i + 2] = img.data[i + 2]! + n;
    }
    g.putImageData(img, 0, 0);
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/jpeg', 0.97));
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  return new Uint8Array(arr);
}

/** The darkest red value inside a rectangle [x0, y0, x1, y1] of an image. */
async function darkest(page: Page, bytes: Buffer, [x0, y0, x1, y1]: [number, number, number, number]): Promise<number> {
  return page.evaluate(
    async ({ b64, x0, y0, x1, y1 }) => {
      const u8 = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([u8]));
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      const g = c.getContext('2d')!;
      g.drawImage(bmp, 0, 0);
      const d = g.getImageData(x0, y0, x1 - x0, y1 - y0).data;
      let min = 255;
      for (let i = 0; i < d.length; i += 4) min = Math.min(min, d[i]!);
      return min;
    },
    { b64: bytes.toString('base64'), x0, y0, x1, y1 },
  );
}

test('a PDF is detected and offered images, Word, text, Markdown and a smaller PDF', async ({ page }) => {
  const errors = await open(page);
  const pdf = await buildPdf({ textPages: SAMPLE_TEXT_PAGES });
  await addFiles(page, [{ name: 'report.pdf', mimeType: 'application/pdf', buffer: pdf }]);
  const row = card(page, 'report.pdf');
  await expect(row).toContainText('PDF ·');
  expect(await row.getByTestId('row-target').locator('option').allTextContents()).toEqual(['PNG images', 'JPEG images', 'Word (text)', 'Text', 'Markdown', 'Smaller PDF']);
  await expect(row.locator('.preview .thumb-doc').first()).toHaveText('PDF');
  expect(errors).toEqual([]);
});

test('PDF → PNG: one image per page at 150 dpi, packed in a ZIP', async ({ page }) => {
  test.slow();
  const errors = await open(page);
  await addFiles(page, [{ name: 'report.pdf', mimeType: 'application/pdf', buffer: await buildPdf({ textPages: SAMPLE_TEXT_PAGES }) }]);
  const { name, bytes, row } = await convertRow(page, 'report.pdf', 'png');
  expect(name).toBe('report.zip');
  const zip = await JSZip.loadAsync(bytes);
  expect(Object.keys(zip.files)).toEqual(['report-page-1.png', 'report-page-2.png']);
  const first = Buffer.from(await zip.file('report-page-1.png')!.async('uint8array'));
  expect(sniff(first).formatId).toBe('png');
  // A4 at 150 dpi; white paper; black ink where the heading was drawn
  // (22 pt bold at x = 56 pt, baseline 82 pt from the top: about 116–400 px across, 150–172 px down).
  const { width, height, rgba } = await pixelsAt(page, first, 'image/png', [[20, 20]]);
  expect([width, height]).toEqual([1239, 1754]);
  expect(rgba[0]).toEqual([255, 255, 255, 255]);
  expect(await darkest(page, first, [116, 145, 400, 175])).toBeLessThan(80);
  expect(await darkest(page, first, [116, 20, 400, 100])).toBe(255); // nothing above the heading
  await expect(row).toContainText('2 pages saved as PNG images (150 dpi) in one ZIP file.');
  await expect(row.locator('.preview-after .thumb-doc')).toHaveText('ZIP');
  await expect(row.getByTestId('status')).toContainText('Converted to PNG images (ZIP)');
  expect(errors).toEqual([]);
});

test('a one-page PDF → JPEG gives a single image, not a ZIP', async ({ page }) => {
  await open(page);
  await addFiles(page, [{ name: 'one.pdf', mimeType: 'application/pdf', buffer: await buildPdf({ textPages: SAMPLE_TEXT_PAGES.slice(0, 1) }) }]);
  const { name, bytes } = await convertRow(page, 'one.pdf', 'jpeg');
  expect(name).toBe('one.jpg');
  expect(sniff(bytes).formatId).toBe('jpeg');
});

test('PDF → text, Markdown and Word keep paragraphs and headings; scanned pages are reported', async ({ page }) => {
  test.slow();
  await open(page);
  const pdf = await buildPdf({ textPages: SAMPLE_TEXT_PAGES, scans: [await scanJpeg(page)] });
  await addFiles(page, [{ name: 'mixed.pdf', mimeType: 'application/pdf', buffer: pdf }]);

  const txt = await convertRow(page, 'mixed.pdf', 'txt');
  expect(txt.name).toBe('mixed.txt');
  expect(txt.bytes.toString('utf8')).toBe(
    'Chapter One\n\nOpenConverter turns PDF pages into images, text and Word documents on your device.\n\nA second paragraph starts here and continues on the next line.\n\nChapter Two\n\nThe second page has its own text.\n',
  );
  await expect(txt.row).toContainText('1 page had no selectable text (probably scanned) and was left out.');

  const md = await convertRow(page, 'mixed.pdf', 'md');
  expect(md.bytes.toString('utf8')).toMatch(/^# Chapter One\n\nOpenConverter turns/);
  expect(md.bytes.toString('utf8')).toContain('\n\n# Chapter Two\n\n');

  const word = await convertRow(page, 'mixed.pdf', 'docx');
  expect(word.name).toBe('mixed.docx');
  const xml = await (await JSZip.loadAsync(word.bytes)).file('word/document.xml')!.async('string');
  expect(xml).toMatch(/w:val="Heading1"[\s\S]*Chapter One/);
  expect(xml).toContain('A second paragraph starts here and continues on the next line.');
  expect(xml).toContain('w:type="page"'); // page break between the two text pages
  await expect(word.row).toContainText("Layout, fonts, images and tables aren't kept.");
});

// Regression: CI's WebKit (Safari 26) failed every PDF text extraction.
// pdf.js reads page text with `for await (… of readableStream)`, and Safari
// only supports that from version 27. Removing the feature before the page
// loads reproduces it in every browser project.
test('PDF text extraction works in browsers that cannot iterate ReadableStreams (Safari 26 and earlier)', async ({ page }) => {
  await page.addInitScript(() => {
    const proto = ReadableStream.prototype as unknown as Record<PropertyKey, unknown>;
    delete proto[Symbol.asyncIterator];
    delete proto.values;
  });
  await open(page);
  expect(await page.evaluate(() => Symbol.asyncIterator in ReadableStream.prototype)).toBe(false);
  await addFiles(page, [{ name: 'report.pdf', mimeType: 'application/pdf', buffer: await buildPdf({ textPages: SAMPLE_TEXT_PAGES }) }]);
  const txt = await convertRow(page, 'report.pdf', 'txt');
  expect(txt.bytes.toString('utf8')).toBe(
    'Chapter One\n\nOpenConverter turns PDF pages into images, text and Word documents on your device.\n\nA second paragraph starts here and continues on the next line.\n\nChapter Two\n\nThe second page has its own text.\n',
  );
  const md = await convertRow(page, 'report.pdf', 'md');
  expect(md.bytes.toString('utf8')).toMatch(/^# Chapter One\n\n/);
});

test('a scanned-only PDF explains that text needs OCR', async ({ page }) => {
  test.slow();
  await open(page);
  await addFiles(page, [{ name: 'scan.pdf', mimeType: 'application/pdf', buffer: await buildPdf({ scans: [await scanJpeg(page)] }) }]);
  const row = card(page, 'scan.pdf');
  await row.getByTestId('row-target').selectOption('txt');
  await page.getByTestId('convert').click();
  await expect(row).toHaveAttribute('data-status', 'error', { timeout: 60_000 });
  await expect(row).toContainText("no selectable text, so it's probably a scan");
  await expect(row).toContainText('Convert it to PNG or JPEG images instead.');
});

test('Smaller PDF re-compresses scanned pages, keeps text pages, and stays a valid PDF', async ({ page }) => {
  test.slow();
  await open(page);
  const pdf = await buildPdf({ textPages: SAMPLE_TEXT_PAGES.slice(0, 1), scans: [await scanJpeg(page)] });
  await addFiles(page, [{ name: 'scanned.pdf', mimeType: 'application/pdf', buffer: pdf }]);
  const { name, bytes, row } = await convertRow(page, 'scanned.pdf', 'pdf');
  expect(name).toBe('scanned.pdf');
  expect(bytes.length).toBeLessThan(pdf.length * 0.7);
  const doc = await PDFDocument.load(bytes);
  expect(doc.getPageCount()).toBe(2);
  expect(doc.getPage(1).getSize()).toEqual({ width: 595, height: 842 });
  await expect(row).toContainText('1 scanned page was re-compressed as JPEG at 150 dpi. Pages with text were kept as they are.');
  // The text page still has real, selectable text.
  await page.getByTestId('clear').click();
  await addFiles(page, [{ name: 'scanned.pdf', mimeType: 'application/pdf', buffer: bytes }]);
  const text = await convertRow(page, 'scanned.pdf', 'txt');
  expect(text.bytes.toString('utf8')).toContain('Chapter One');
});

test('an already compact PDF is kept as it is, and the app says so', async ({ page }) => {
  await open(page);
  const pdf = await buildPdf({ textPages: SAMPLE_TEXT_PAGES });
  await addFiles(page, [{ name: 'tiny.pdf', mimeType: 'application/pdf', buffer: pdf }]);
  const { bytes, row } = await convertRow(page, 'tiny.pdf', 'pdf');
  expect(Buffer.compare(bytes, pdf)).toBe(0);
  await expect(row).toContainText('This PDF is already compact.');
});

test('a damaged PDF gets a clear error', async ({ page }) => {
  await open(page);
  await addFiles(page, [{ name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\nthis is not really a pdf\n') }]);
  const row = card(page, 'broken.pdf');
  await page.getByTestId('convert').click();
  await expect(row).toHaveAttribute('data-status', 'error', { timeout: 30_000 });
  await expect(row).toContainText(/This PDF couldn't be (read|opened)/);
});

test('Markdown → PDF and Word; the PDF has real text that reads back', async ({ page }) => {
  test.slow();
  await open(page);
  const md = '# Release notes\n\nVersion **2** adds:\n\n- PDF export\n- Word export\n\n| Item | Count |\n|---|---|\n| Pages | 3 |\n';
  await addFiles(page, [{ name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from(md) }]);
  expect(await card(page, 'notes.md').getByTestId('row-target').locator('option').allTextContents()).toEqual(['PDF', 'Word', 'HTML', 'Text']);
  const pdf = await convertRow(page, 'notes.md', 'pdf');
  expect(pdf.name).toBe('notes.pdf');
  expect((await PDFDocument.load(pdf.bytes)).getTitle()).toBe('notes');
  const docx = await convertRow(page, 'notes.md', 'docx');
  const xml = await (await JSZip.loadAsync(docx.bytes)).file('word/document.xml')!.async('string');
  expect(xml).toMatch(/Heading1[\s\S]*Release notes/);
  expect(xml).toContain('<w:tbl>');

  // Round trip: the PDF we wrote is read back by the PDF reader.
  await page.getByTestId('clear').click();
  await addFiles(page, [{ name: 'notes.pdf', mimeType: 'application/pdf', buffer: pdf.bytes }]);
  const back = await convertRow(page, 'notes.pdf', 'txt');
  const text = back.bytes.toString('utf8');
  for (const s of ['Release notes', 'Version 2 adds:', 'PDF export', 'Word export', 'Item', 'Pages']) expect(text).toContain(s);
});

test('text with characters the PDF fonts lack: PDF explains, Word keeps them', async ({ page }) => {
  await open(page);
  await addFiles(page, [{ name: 'greet.txt', mimeType: 'text/plain', buffer: Buffer.from('Hello / नमस्ते\n') }]);
  const pdf = await convertRow(page, 'greet.txt', 'pdf');
  await expect(pdf.row).toContainText("can't be shown with the built-in PDF fonts");
  const docx = await convertRow(page, 'greet.txt', 'docx');
  const xml = await (await JSZip.loadAsync(docx.bytes)).file('word/document.xml')!.async('string');
  expect(xml).toContain('Hello / नमस्ते');
  await expect(docx.row.locator('.msg')).toHaveCount(0);
});

test('CSV → PDF table', async ({ page }) => {
  await open(page);
  await addFiles(page, [{ name: 'sales.csv', mimeType: 'text/csv', buffer: Buffer.from('month,revenue\nJan,1200\nFeb,1350\n') }]);
  const pdf = await convertRow(page, 'sales.csv', 'pdf');
  expect(sniff(pdf.bytes).formatId).toBe('pdf');
  await page.getByTestId('clear').click();
  await addFiles(page, [{ name: 'sales.pdf', mimeType: 'application/pdf', buffer: pdf.bytes }]);
  const text = (await convertRow(page, 'sales.pdf', 'txt')).bytes.toString('utf8');
  for (const s of ['month', 'revenue', 'Jan', '1200', 'Feb', '1350']) expect(text).toContain(s);
});

test('PDF conversion makes no request outside this site', async ({ page }) => {
  test.slow();
  const outside: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!['http:', 'https:'].includes(u.protocol)) return;
    if (u.host !== 'localhost:4173') outside.push(r.url());
  });
  await open(page);
  await addFiles(page, [{ name: 'report.pdf', mimeType: 'application/pdf', buffer: await buildPdf({ textPages: SAMPLE_TEXT_PAGES }) }]);
  await convertRow(page, 'report.pdf', 'png');
  await convertRow(page, 'report.pdf', 'docx');
  expect(outside).toEqual([]);
});

test('the standalone file explains that PDFs need the website, and offers no PDF or Word output', async ({ page }) => {
  await page.goto(pathToFileURL(resolve('dist-standalone/index.html')).href);
  await expect(page.locator('#app')).not.toHaveAttribute('aria-busy');
  await addFiles(page, [
    { name: 'report.pdf', mimeType: 'application/pdf', buffer: await buildPdf({ textPages: SAMPLE_TEXT_PAGES }) },
    { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Hi') },
  ]);
  await expect(card(page, 'report.pdf')).toContainText('PDF files can only be converted on the OpenConverter website');
  expect(await card(page, 'notes.md').getByTestId('row-target').locator('option').allTextContents()).toEqual(['HTML', 'Text']);
});
