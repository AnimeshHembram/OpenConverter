import { expect, test, type Page } from '@playwright/test';
import ExcelJS from 'exceljs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseCsv } from '../../src/core/csv';
import { addFiles, makeImage, open } from './helpers';

/**
 * Level 2, stage 1: text and data files. Each file is detected from its
 * content, gets its own "Convert to" choice, and the downloaded output is
 * parsed and checked, not just its name.
 */

const text = (s: string) => Buffer.from(s, 'utf8');
const card = (page: Page, name: string) => page.getByTestId('file-card').filter({ hasText: name });

async function convertRow(page: Page, name: string, target?: string) {
  const row = card(page, name);
  if (target) await row.getByTestId('row-target').selectOption(target);
  await page.getByTestId('convert').click();
  await expect(row).toHaveAttribute('data-status', 'done', { timeout: 45_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), row.getByTestId('download').click()]);
  return { name: download.suggestedFilename(), bytes: await readFile((await download.path())!), row };
}

async function readXlsx(bytes: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  return wb;
}

/** A real one-sheet workbook, written in Node with the same library the app uses. */
async function makeXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Sheet1').addRow(['a', 1]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const PEOPLE_CSV = 'name,age,city\nAna,31,"Ranchi, JH"\nBo,27,Bengaluru\n';

test('each kind of document is detected from its content and offered the right outputs', async ({ page }) => {
  const errors = await open(page);
  await addFiles(page, [
    { name: 'people.csv', mimeType: 'text/csv', buffer: text(PEOPLE_CSV) },
    { name: 'data.json', mimeType: 'application/json', buffer: text('[{"a":1},{"a":2},{"a":3}]') },
    { name: 'notes.md', mimeType: 'text/markdown', buffer: text('# Notes\n\n- one\n- two\n') },
    { name: 'plain.txt', mimeType: 'text/plain', buffer: text('Just some words here.') },
    { name: 'export.txt', mimeType: 'text/plain', buffer: text('{"report": [1, 2]}') },
  ]);
  await expect(card(page, 'people.csv')).toContainText('CSV · 3 rows × 3 columns');
  await expect(card(page, 'data.json')).toContainText('JSON · 3 items');
  await expect(card(page, 'notes.md')).toContainText('Markdown · 5 lines · 6 words');
  await expect(card(page, 'plain.txt')).toContainText('Text · 1 line · 4 words');
  await expect(card(page, 'export.txt')).toContainText("This .txt file contains JSON, so it's treated as JSON.");

  const options = (name: string) => card(page, name).getByTestId('row-target').locator('option').allTextContents();
  expect(await options('people.csv')).toEqual(['Excel', 'JSON', 'Markdown', 'HTML']);
  expect(await options('data.json')).toEqual(['CSV', 'Excel', 'Markdown']);
  expect(await options('notes.md')).toEqual(['HTML', 'Text']);
  expect(await options('plain.txt')).toEqual(['Markdown', 'HTML']);
  await expect(card(page, 'people.csv').getByRole('combobox', { name: 'Convert people.csv to' })).toHaveValue('xlsx');
  // With only documents, the image settings stay out of the way.
  await expect(page.getByTestId('target')).toBeHidden();
  await expect(card(page, 'people.csv').locator('.thumb-doc').first()).toHaveText('CSV');
  expect(errors).toEqual([]);
});

test('CSV → Excel: a real workbook with typed cells and a bold header, which converts back to CSV and JSON', async ({ page }) => {
  test.slow();
  await open(page);
  await addFiles(page, [{ name: 'people.csv', mimeType: 'text/csv', buffer: text(PEOPLE_CSV) }]);
  const { name, bytes, row } = await convertRow(page, 'people.csv', 'xlsx');
  expect(name).toBe('people.xlsx');
  const ws = (await readXlsx(bytes)).worksheets[0]!;
  expect(ws.getRow(1).values).toEqual([undefined, 'name', 'age', 'city']);
  expect(ws.getRow(2).values).toEqual([undefined, 'Ana', 31, 'Ranchi, JH']);
  expect(ws.getRow(1).font?.bold).toBe(true);
  await expect(row.locator('.thumb-doc').last()).toHaveText('XLSX');

  // Feed the workbook back in: detected as Excel, converted to CSV and JSON.
  await page.getByTestId('clear').click();
  await addFiles(page, [{ name: 'people.xlsx', mimeType: 'application/octet-stream', buffer: bytes }]);
  await expect(card(page, 'people.xlsx')).toContainText('Excel · Excel workbook');
  const csv = await convertRow(page, 'people.xlsx', 'csv');
  expect(csv.name).toBe('people.csv');
  expect(csv.bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf])); // BOM so Excel reads UTF-8
  expect(parseCsv(csv.bytes.toString('utf8'))).toEqual(parseCsv(PEOPLE_CSV));
  const json = await convertRow(page, 'people.xlsx', 'json');
  expect(JSON.parse(json.bytes.toString('utf8'))).toEqual([
    { name: 'Ana', age: 31, city: 'Ranchi, JH' },
    { name: 'Bo', age: 27, city: 'Bengaluru' },
  ]);
});

test('JSON → CSV flattens objects into columns and explains nested values', async ({ page }) => {
  await open(page);
  const data = [{ id: 1, name: 'Pen', tags: ['blue'] }, { id: 2, name: 'Ink' }];
  await addFiles(page, [{ name: 'items.json', mimeType: 'application/json', buffer: text(JSON.stringify(data)) }]);
  const { name, bytes, row } = await convertRow(page, 'items.json', 'csv');
  expect(name).toBe('items.csv');
  expect(parseCsv(bytes.toString('utf8'))).toEqual([
    ['id', 'name', 'tags'],
    ['1', 'Pen', '["blue"]'],
    ['2', 'Ink', ''],
  ]);
  await expect(row).toContainText('written as JSON text');
});

test('Markdown → HTML, previewed safely as text side by side', async ({ page }) => {
  const errors = await open(page);
  const md = '# Hello\n\nSome <b>raw html</b> and **bold**.\n';
  await addFiles(page, [{ name: 'notes.md', mimeType: 'text/markdown', buffer: text(md) }]);
  const { name, bytes, row } = await convertRow(page, 'notes.md', 'html');
  expect(name).toBe('notes.html');
  const html = bytes.toString('utf8');
  expect(html).toMatch(/^<!doctype html>/);
  expect(html).toContain('<h1>Hello</h1>');
  expect(html).toContain('<strong>bold</strong>');

  await row.getByTestId('preview').click();
  const dialog = page.getByTestId('preview-dialog');
  const previews = dialog.getByTestId('text-preview');
  await expect(previews).toHaveCount(2);
  await expect(previews.first()).toHaveText(md);
  await expect(previews.last()).toContainText('<h1>Hello</h1>'); // shown as source, not rendered
  await expect(dialog.locator('b, h1')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Download notes.html' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('Markdown → text and text → Markdown', async ({ page }) => {
  await open(page);
  await addFiles(page, [
    { name: 'a.md', mimeType: 'text/markdown', buffer: text('## Title\n\n**Bold** [link](https://x.y)\n') },
    { name: 'b.txt', mimeType: 'text/plain', buffer: text('# not a heading\nline two\n') },
  ]);
  await card(page, 'a.md').getByTestId('row-target').selectOption('txt');
  const a = await convertRow(page, 'a.md');
  expect(a.name).toBe('a.txt');
  expect(a.bytes.toString('utf8')).toBe('Title\n\nBold link\n');
  const [dl] = await Promise.all([page.waitForEvent('download'), card(page, 'b.txt').getByTestId('download').click()]);
  expect(dl.suggestedFilename()).toBe('b.md');
  expect((await readFile((await dl.path())!)).toString('utf8')).toBe('\\# not a heading\\\nline two\n');
});

test('changing a document output marks its result out of date; mixed batches download as one ZIP', async ({ page }) => {
  await open(page);
  const png = await makeImage(page, { mime: 'image/png', width: 8, height: 8 });
  await addFiles(page, [
    { name: 'pic.png', mimeType: 'image/png', buffer: png },
    { name: 'people.csv', mimeType: 'text/csv', buffer: text(PEOPLE_CSV) },
  ]);
  await expect(page.getByRole('combobox', { name: 'Convert images to' })).toBeVisible();
  await page.getByTestId('target').selectOption('jpeg');
  await card(page, 'people.csv').getByTestId('row-target').selectOption('json');
  await page.getByTestId('convert').click();
  await expect(page.getByTestId('list-summary')).toHaveText('2 converted');

  const [zip] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download-all').click()]);
  expect(zip.suggestedFilename()).toBe('openconverter-2-files.zip');

  await card(page, 'people.csv').getByTestId('row-target').selectOption('md');
  await expect(card(page, 'people.csv').getByTestId('status')).toContainText('output changed, convert again');
  await expect(card(page, 'pic.png').getByTestId('status')).not.toContainText('changed');
  await expect(page.getByTestId('convert')).toHaveText('Convert');
});

test('Office files that are not supported yet get specific advice', async ({ page }) => {
  await open(page);
  const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
  await addFiles(page, [
    { name: 'old.xls', mimeType: 'application/vnd.ms-excel', buffer: ole },
    { name: 'old.doc', mimeType: 'application/msword', buffer: ole },
    { name: 'broken.json', mimeType: 'application/json', buffer: text('{"a": }') },
  ]);
  await expect(card(page, 'old.xls')).toContainText('old-style Excel workbook (.xls, Office 97–2003)');
  await expect(card(page, 'old.xls')).toContainText('save it as .xlsx');
  await expect(card(page, 'old.doc')).toContainText('old-style Word document');
  await expect(card(page, 'broken.json')).toContainText("isn't valid JSON");
  await expect(page.getByTestId('convert')).toBeDisabled();
});

test('the standalone file converts text and data, and explains that Excel needs the website', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(pathToFileURL(resolve('dist-standalone/index.html')).href);
  await expect(page.locator('#app')).not.toHaveAttribute('aria-busy');
  await addFiles(page, [
    { name: 'people.csv', mimeType: 'text/csv', buffer: text(PEOPLE_CSV) },
    { name: 'book.xlsx', mimeType: 'application/octet-stream', buffer: await makeXlsx() },
  ]);
  const csv = card(page, 'people.csv');
  expect(await csv.getByTestId('row-target').locator('option').allTextContents()).toEqual(['JSON', 'Markdown', 'HTML']);
  const { bytes } = await convertRow(page, 'people.csv');
  expect(JSON.parse(bytes.toString('utf8'))[0]).toEqual({ name: 'Ana', age: 31, city: 'Ranchi, JH' });
  await expect(card(page, 'book.xlsx')).toHaveAttribute('data-status', 'error');
  await expect(card(page, 'book.xlsx')).toContainText('Excel files can only be converted on the OpenConverter website');
  expect(errors).toEqual([]);
});
