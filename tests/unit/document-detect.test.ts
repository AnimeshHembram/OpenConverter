import { describe, expect, it } from 'vitest';
import { parseCsv, toCsv } from '../../src/core/csv';
import { sniff } from '../../src/core/detect';
import { inspectFile } from '../../src/core/inspect';
import { classifyText, decodeText, detectDelimiter, looksLikeText, markdownScore } from '../../src/core/text';
import { createZip } from '../../src/core/zip';
import { officeKind, zipEntryNames } from '../../src/core/zipdir';

const file = (content: string | Uint8Array | Blob, name: string) => new File([content as BlobPart], name);
const zipOf = (...names: string[]) => createZip(names.map((n) => ({ name: n, data: new Blob(['<x/>']) })));

describe('text decoding', () => {
  it('reads UTF-8 (with or without BOM), UTF-16 and falls back to Windows-1252', () => {
    expect(decodeText(new TextEncoder().encode('héllo'))).toEqual({ text: 'héllo', encoding: 'utf-8' });
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toEqual({ text: 'a', encoding: 'utf-8' });
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x61, 0x00])).text).toBe('a');
    expect(decodeText(new Uint8Array([0x63, 0x61, 0x66, 0xe9]))).toEqual({ text: 'café', encoding: 'windows-1252' });
  });

  it('tells text from binary', () => {
    expect(looksLikeText(new TextEncoder().encode('just words\nand lines'))).toBe(true);
    expect(looksLikeText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]))).toBe(false);
    expect(looksLikeText(new Uint8Array([]))).toBe(false);
  });
});

describe('classifyText', () => {
  it('recognises JSON by parsing, whatever the extension', () => {
    expect(classifyText('{"a": 1}', 'json')).toBe('json');
    expect(classifyText('[1, 2, 3]', 'txt')).toBe('json');
    expect(classifyText('[not json', 'txt')).toBe('txt');
    expect(classifyText('{broken', 'json')).toBe('json'); // rejected later with a clear message
  });

  it('trusts .csv and .md extensions', () => {
    expect(classifyText('a,b\n1,2', 'csv')).toBe('csv');
    expect(classifyText('a\tb\n1\t2', 'tsv')).toBe('csv');
    expect(classifyText('hello', 'md')).toBe('md');
  });

  it('only turns a .txt file into CSV or Markdown when the content is unambiguous', () => {
    expect(classifyText('a,b,c\n1,2,3\n4,5,6\n7,8,9\n10,11,12', 'txt')).toBe('csv');
    expect(classifyText('Hello, world.\nGoodbye, moon.', 'txt')).toBe('txt');
    expect(classifyText('# Title\n\n- one\n- two\n\nSee [docs](https://x.y) and **this**.', 'txt')).toBe('md');
    expect(classifyText('Just a note with a - dash.', 'txt')).toBe('txt');
  });

  it('classifies files without an extension by content', () => {
    expect(classifyText('name;age\nAna;3\nBo;4', '')).toBe('csv');
    expect(classifyText('# Heading\n\n```js\nx\n```', '')).toBe('md');
    expect(classifyText('plain words', '')).toBe('txt');
  });

  it('scores Markdown features and detects delimiters', () => {
    expect(markdownScore('plain')).toBe(0);
    expect(markdownScore('# T\n- a\n**b**')).toBe(3);
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('a|b\n1|2')).toBe('|');
    expect(detectDelimiter('"x,y",b\n1,2')).toBe(',');
    expect(detectDelimiter('one line only')).toBeNull();
  });
});

describe('CSV', () => {
  it('parses quotes, embedded delimiters, line breaks and doubled quotes', () => {
    expect(parseCsv('name,quote\r\n"Smith, J","He said ""hi""\nthen left"\r\n', ',')).toEqual([
      ['name', 'quote'],
      ['Smith, J', 'He said "hi"\nthen left'],
    ]);
  });

  it('skips a BOM and blank lines, keeps empty fields', () => {
    expect(parseCsv('﻿a,b\n\n1,\n', ',')).toEqual([
      ['a', 'b'],
      ['1', ''],
    ]);
  });

  it('round-trips through toCsv', () => {
    const rows = [
      ['a', 'b, c', 'say "x"'],
      ['line\nbreak', ' padded ', ''],
    ];
    expect(parseCsv(toCsv(rows), ',')).toEqual(rows);
    expect(toCsv([['1', '2']])).toBe('1,2\r\n');
  });
});

describe('ZIP and Office detection', () => {
  it('lists entry names from the central directory', async () => {
    expect(await zipEntryNames(await zipOf('[Content_Types].xml', 'xl/workbook.xml'))).toEqual(['[Content_Types].xml', 'xl/workbook.xml']);
    expect(await zipEntryNames(new Blob(['not a zip']))).toBeNull();
  });

  it('identifies Word, Excel, PowerPoint and OpenDocument files', () => {
    expect(officeKind(['[Content_Types].xml', 'word/document.xml'])).toBe('docx');
    expect(officeKind(['[Content_Types].xml', 'xl/workbook.xml'])).toBe('xlsx');
    expect(officeKind(['[Content_Types].xml', 'ppt/presentation.xml'])).toBe('pptx');
    expect(officeKind(['mimetype'], 'application/vnd.oasis.opendocument.spreadsheet')).toBe('ods');
    expect(officeKind(['a.txt'])).toBeNull();
  });

  it('sniffs ZIP and Office 97–2003 containers', () => {
    expect(sniff(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0])).container).toBe('zip');
    expect(sniff(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])).container).toBe('ole');
  });
});

describe('inspectFile for documents', () => {
  it('detects JSON, CSV, Markdown and text with useful details', async () => {
    expect(await inspectFile(file('[{"a":1},{"a":2}]', 'data.json'))).toMatchObject({ format: { id: 'json' }, details: '2 items', warnings: [] });
    expect(await inspectFile(file('{"x":1,"y":2}', 'cfg.json'))).toMatchObject({ details: '2 keys' });
    expect(await inspectFile(file('a,b,c\n1,2,3\n4,5,6\n', 'table.csv'))).toMatchObject({ format: { id: 'csv' }, details: '3 rows × 3 columns' });
    expect(await inspectFile(file('# Hi\n\nThere', 'readme.md'))).toMatchObject({ format: { id: 'md' }, details: '3 lines · 3 words' });
    expect(await inspectFile(file('one two', 'note.txt'))).toMatchObject({ format: { id: 'txt' }, details: '1 line · 2 words' });
  });

  it('explains what it detected when content and name disagree', async () => {
    const asTxt = await inspectFile(file('{"a":1}', 'export.txt'));
    expect(asTxt.format.id).toBe('json');
    expect(asTxt.warnings[0]).toMatch(/This \.txt file contains JSON, so it's treated as JSON/);
    const misnamed = await inspectFile(file('[1,2]', 'list.csv'));
    expect(misnamed.format.id).toBe('json');
    expect(misnamed.warnings[0]).toMatch(/named \.csv but contains JSON/);
  });

  it('rejects invalid JSON with the parser message', async () => {
    await expect(inspectFile(file('{"a": }', 'bad.json'))).rejects.toThrow(/isn't valid JSON/);
  });

  it('warns when text is not UTF-8', async () => {
    const info = await inspectFile(file(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), 'menu.txt'));
    expect(info.warnings[0]).toMatch(/Windows-1252/);
  });

  it('detects Excel workbooks and explains unsupported Office files', async () => {
    const xlsx = await zipOf('[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml');
    expect(await inspectFile(file(xlsx, 'book.xlsx'))).toMatchObject({ format: { id: 'xlsx' }, details: 'Excel workbook' });
    await expect(inspectFile(file(await zipOf('[Content_Types].xml', 'word/document.xml'), 'a.docx'))).rejects.toThrow(/Word documents can't be converted yet/);
    await expect(inspectFile(file(await zipOf('photos/a.jpg'), 'a.zip'))).rejects.toThrow(/ZIP archives aren't supported/);
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    await expect(inspectFile(file(ole, 'old.xls'))).rejects.toThrow(/old-style Excel workbook \(\.xls.*save it as \.xlsx/);
    await expect(inspectFile(file(ole, 'old.doc'))).rejects.toThrow(/old-style Word document/);
  });

  it('rejects a text file named like an image as a damaged image', async () => {
    await expect(inspectFile(file('hello', 'photo.jpg'))).rejects.toThrow(/doesn't look like a JPEG image/);
  });
});
