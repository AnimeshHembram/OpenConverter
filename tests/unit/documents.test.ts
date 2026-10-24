import { describe, expect, it } from 'vitest';
import { parseCsv } from '../../src/core/csv';
import { getFormat } from '../../src/core/formats';
import { createDocumentConverter, DOCUMENT_OUTPUTS, verifyDocument } from '../../src/modules/document/converter';
import { markdownToText, textToMarkdown } from '../../src/modules/document/markdown';
import { coerce, headerNames, jsonToSheets, sheetToObjects, toMarkdownTable } from '../../src/modules/document/table';
import { cellValue, readWorkbook, sheetNames, writeWorkbook } from '../../src/modules/document/xlsx';

const conv = createDocumentConverter({ spreadsheets: true });
const ctx = () => ({ signal: new AbortController().signal, onProgress: () => {} });

async function convert(content: BlobPart, name: string, from: string, to: string) {
  const r = await conv.convert({ file: new Blob([content]), name, format: getFormat(from) }, to, { quality: 1, background: '#fff' }, ctx());
  return { ...r, text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(await r.blob.arrayBuffer()) };
}

describe('tables', () => {
  it('turns an array of objects into columns, in first-seen key order', () => {
    const { sheets, notes } = jsonToSheets([{ a: 1, b: 'x' }, { b: 'y', c: true }]);
    expect(sheets[0]!.rows).toEqual([
      ['a', 'b', 'c'],
      [1, 'x', null],
      [null, 'y', true],
    ]);
    expect(notes.nested).toBe(false);
  });

  it('writes nested values as JSON text and says so', () => {
    const { sheets, notes } = jsonToSheets([{ id: 1, tags: ['a', 'b'], meta: { x: 1 } }]);
    expect(sheets[0]!.rows[1]).toEqual([1, '["a","b"]', '{"x":1}']);
    expect(notes.nested).toBe(true);
  });

  it('unwraps { "data": [...] } and splits an object of lists into sheets', () => {
    expect(jsonToSheets({ data: [{ a: 1 }] })).toMatchObject({ sheets: [{ name: 'data', rows: [['a'], [1]] }], notes: { unwrapped: 'data' } });
    const multi = jsonToSheets({ Sales: [{ q: 1 }], Costs: [{ q: 2 }] });
    expect(multi.sheets.map((s) => s.name)).toEqual(['Sales', 'Costs']);
  });

  it('handles plain objects, primitives and arrays of arrays', () => {
    expect(jsonToSheets({ a: 1, b: 2 }).sheets[0]!.rows).toEqual([['key', 'value'], ['a', 1], ['b', 2]]);
    expect(jsonToSheets([1, 2]).sheets[0]!.rows).toEqual([['value'], [1], [2]]);
    expect(jsonToSheets([[1, 2], [3, 4]]).sheets[0]!.rows).toEqual([[1, 2], [3, 4]]);
    expect(jsonToSheets('hi').sheets[0]!.rows).toEqual([['value'], ['hi']]);
  });

  it('keeps IDs and phone numbers as text when typing CSV values', () => {
    expect(coerce('42')).toBe(42);
    expect(coerce('-3.5')).toBe(-3.5);
    expect(coerce('007')).toBe('007');
    expect(coerce('9876543210123456789')).toBe('9876543210123456789');
    expect(coerce('1e5')).toBe('1e5');
    expect(coerce('TRUE')).toBe(true);
    expect(coerce('')).toBe('');
  });

  it('makes header names unique and fills blanks', () => {
    expect(headerNames(['a', '', 'a', null])).toEqual(['a', 'column_2', 'a_2', 'column_4']);
    expect(sheetToObjects([['a', 'b'], [1, 2], [null, ''], [3]])).toEqual([{ a: 1, b: 2 }, { a: 3, b: null }]);
  });

  it('escapes pipes and line breaks in Markdown tables', () => {
    expect(toMarkdownTable([['a|b', 'c'], ['x\ny', 1]])).toBe('| a\\|b | c |\n| --- | --- |\n| x<br>y | 1 |\n');
  });
});

describe('Markdown and text', () => {
  it('turns Markdown into readable text', () => {
    const md = '# Title\n\nSome **bold** and [a link](https://x.y).\n\n- one\n- two\n\n1. first\n2. second\n\n```\ncode here\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
    expect(markdownToText(md)).toBe('Title\n\nSome bold and a link.\n\n- one\n- two\n\n1. first\n2. second\n\ncode here\n\na\tb\n1\t2\n');
  });

  it('escapes text so Markdown renders it unchanged', () => {
    expect(textToMarkdown('# not a heading\n*not bold*\n1. not a list\n\nnext para')).toBe('\\# not a heading\\\n\\*not bold\\*\\\n1\\. not a list\n\nnext para\n');
  });
});

describe('document converter', () => {
  it('offers the documented outputs, with the default first', () => {
    expect(conv.outputsFor('csv')).toEqual(['xlsx', 'json', 'md', 'html']);
    expect(conv.outputsFor('png')).toEqual([]);
    const offline = createDocumentConverter({ spreadsheets: false });
    expect(offline.outputsFor('csv')).toEqual(['json', 'md', 'html']);
    expect(offline.outputsFor('xlsx')).toEqual([]);
    expect(offline.unavailableReason?.('xlsx')).toMatch(/website/);
    for (const [from, tos] of Object.entries(DOCUMENT_OUTPUTS)) expect(tos).not.toContain(from);
  });

  it('CSV → JSON with typed values', async () => {
    const r = await convert('name,age,zip\nAna,31,007\n"Lee, B",42,110001\n', 'people.csv', 'csv', 'json');
    expect(r.fileName).toBe('people.json');
    expect(r.blob.type).toBe('application/json');
    expect(JSON.parse(r.text)).toEqual([
      { name: 'Ana', age: 31, zip: '007' },
      { name: 'Lee, B', age: 42, zip: 110001 },
    ]);
  });

  it('JSON → CSV with a BOM for Excel, quoting where needed', async () => {
    const r = await convert(JSON.stringify([{ city: 'Ranchi, JH', note: 'नमस्ते' }]), 'c.json', 'json', 'csv');
    expect(r.text.startsWith('﻿')).toBe(true);
    expect(parseCsv(r.text)).toEqual([
      ['city', 'note'],
      ['Ranchi, JH', 'नमस्ते'],
    ]);
    expect(r.warnings).toEqual([]);
  });

  it('JSON with several lists → CSV converts the first and explains', async () => {
    const r = await convert(JSON.stringify({ A: [{ x: 1 }], B: [{ y: 2 }] }), 'm.json', 'json', 'csv');
    expect(parseCsv(r.text)).toEqual([['x'], ['1']]);
    expect(r.warnings[0]).toMatch(/2 sheets.*only the first, "A"/);
  });

  it('CSV → Excel → JSON round-trips, keeping types and text that looks like a formula', async () => {
    const csv = 'item,qty,formula\nPen,3,=SUM(1;2)\nInk,0.5,plain\n';
    const x = await convert(csv, 'stock.csv', 'csv', 'xlsx');
    expect(x.fileName).toBe('stock.xlsx');
    const sheets = await readWorkbook(await x.blob.arrayBuffer());
    expect(sheets[0]!.rows).toEqual([
      ['item', 'qty', 'formula'],
      ['Pen', 3, '=SUM(1;2)'],
      ['Ink', 0.5, 'plain'],
    ]);
    const back = await convert(await x.blob.arrayBuffer(), 'stock.xlsx', 'xlsx', 'json');
    expect(JSON.parse(back.text)).toEqual([
      { item: 'Pen', qty: 3, formula: '=SUM(1;2)' },
      { item: 'Ink', qty: 0.5, formula: 'plain' },
    ]);
  });

  it('Excel with several sheets: JSON keeps all, CSV the first, HTML and Markdown all', async () => {
    const { data } = await writeWorkbook([
      { name: 'Sales', rows: [['q', 'v'], ['Q1', 10]] },
      { name: 'Costs', rows: [['q', 'v'], ['Q1', 4]] },
    ]);
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    expect(JSON.parse((await convert(buf, 'b.xlsx', 'xlsx', 'json')).text)).toEqual({ Sales: [{ q: 'Q1', v: 10 }], Costs: [{ q: 'Q1', v: 4 }] });
    const csv = await convert(buf, 'b.xlsx', 'xlsx', 'csv');
    expect(parseCsv(csv.text)).toEqual([['q', 'v'], ['Q1', '10']]);
    expect(csv.warnings[0]).toMatch(/only the first, "Sales"/);
    const md = await convert(buf, 'b.xlsx', 'xlsx', 'md');
    expect(md.text).toContain('## Sales');
    expect(md.text).toContain('## Costs');
    const html = await convert(buf, 'b.xlsx', 'xlsx', 'html');
    expect(html.text).toContain('<h2>Costs</h2>');
    expect(html.warnings).toEqual([]);
  });

  it('JSON → Excel writes a bold, frozen header', async () => {
    const r = await convert(JSON.stringify([{ a: 1 }, { a: 2 }]), 'n.json', 'json', 'xlsx');
    const Excel = (await import('exceljs')).default;
    const wb = new Excel.Workbook();
    await wb.xlsx.load(await r.blob.arrayBuffer());
    const ws = wb.worksheets[0]!;
    expect(ws.getRow(1).font?.bold).toBe(true);
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
  });

  it('Markdown → HTML is a full page; text → HTML escapes everything', async () => {
    const md = await convert('# Hello\n\n- a\n', 'notes.md', 'md', 'html');
    expect(md.fileName).toBe('notes.html');
    expect(md.text).toMatch(/^<!doctype html>/);
    expect(md.text).toContain('<title>notes</title>');
    expect(md.text).toContain('<h1>Hello</h1>');
    const txt = await convert('a <b> & c\nnext\n\npara', 't.txt', 'txt', 'html');
    expect(txt.text).toContain('<p>a &lt;b&gt; &amp; c<br>\nnext</p>\n<p>para</p>');
  });

  it('CSV → HTML table escapes cell text', async () => {
    const r = await convert('a,b\n<script>,x\n', 'x.csv', 'csv', 'html');
    expect(r.text).toContain('<td>&lt;script&gt;</td>');
    expect(r.text).not.toContain('<td><script>');
  });

  it('rejects pairs it does not offer', async () => {
    await expect(convert('x', 'a.txt', 'txt', 'xlsx')).rejects.toMatchObject({ code: 'NO_CONVERTER' });
  });

  it('reads damaged workbooks with a clear error', async () => {
    await expect(readWorkbook(new TextEncoder().encode('nope').buffer as ArrayBuffer)).rejects.toThrow(/couldn't be read/);
  });
});

describe('Excel helpers', () => {
  it('reduces cell values to plain data', () => {
    expect(cellValue({ formula: 'A1+1', result: 3 })).toBe(3);
    expect(cellValue({ richText: [{ text: 'a' }, { text: 'b' }] })).toBe('ab');
    expect(cellValue({ text: 'site', hyperlink: 'https://x' })).toBe('site');
    expect(cellValue({ error: '#DIV/0!' })).toBe('#DIV/0!');
    expect(cellValue(new Date(Date.UTC(2026, 9, 24)))).toBe('2026-10-24');
    expect(cellValue(new Date(Date.UTC(2026, 9, 24, 13, 5)))).toBe('2026-10-24 13:05:00');
  });

  it('makes valid, unique sheet names', () => {
    expect(sheetNames(['a/b', 'A/B', '', 'x'.repeat(40)])).toEqual(['a_b', 'A_B 2', 'Sheet3', 'x'.repeat(31)]);
  });

  it('refuses tables bigger than Excel allows', async () => {
    const wide = [Array.from({ length: 16_385 }, () => 1)];
    await expect(writeWorkbook([{ name: 's', rows: wide }])).rejects.toThrow(/columns/);
  });
});

describe('verifyDocument', () => {
  it('rejects invalid JSON and a non-workbook named .xlsx', async () => {
    await expect(verifyDocument(new Blob(['{']), getFormat('json'), 'a.json')).rejects.toThrow(/JSON file couldn't be created/);
    await expect(verifyDocument(new Blob(['x']), getFormat('xlsx'), 'a.xlsx')).rejects.toThrow(/Excel file/);
    await expect(verifyDocument(new Blob(['x']), getFormat('csv'), 'a.txt')).rejects.toThrow(/doesn't match/);
    expect((await verifyDocument(new Blob(['a,b']), getFormat('csv'), 'a.csv')).type).toBe('text/csv');
  });
});
