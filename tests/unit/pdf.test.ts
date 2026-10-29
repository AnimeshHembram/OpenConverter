import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { getFormat } from '../../src/core/formats';
import { inspectFile } from '../../src/core/inspect';
import { markdownToBlocks, textToBlocks } from '../../src/modules/document/blocks';
import { createDocumentConverter } from '../../src/modules/document/converter';
import { blocksToDocx } from '../../src/modules/document/docxwriter';
import { blocksToPdf, isWinAnsi, sanitize } from '../../src/modules/document/pdfwriter';
import { renderScale } from '../../src/modules/pdf/converter';
import { bodySize, headingLevel, toLines, toParagraphs, type Fragment } from '../../src/modules/pdf/text';
import { buildPdf, SAMPLE_TEXT_PAGES } from '../fixtures/pdfs';

const frag = (str: string, x: number, y: number, size = 11, width = str.length * size * 0.5, eol = false): Fragment => ({ str, x, y, size, width, eol });

describe('PDF text layout', () => {
  it('joins fragments on one baseline into a line, adding spaces only at visible gaps', () => {
    const lines = toLines([frag('Hel', 56, 700, 11, 16), frag('lo', 72, 700, 11, 10), frag('world', 90, 700), frag('Next', 56, 685)]);
    expect(lines.map((l) => l.text)).toEqual(['Hello world', 'Next']);
  });

  it('starts a new line after an explicit end-of-line', () => {
    expect(toLines([frag('a', 56, 700, 11, 5, true), frag('b', 62, 700)]).map((l) => l.text)).toEqual(['a', 'b']);
  });

  it('splits paragraphs at larger gaps and font-size changes, and rejoins hyphenated words', () => {
    const lines = toLines([
      frag('Title', 56, 760, 22),
      frag('First line of a para-', 56, 720),
      frag('graph continues.', 56, 705),
      frag('Second paragraph.', 56, 678),
      frag('Still second.', 56, 663),
    ]);
    const paras = toParagraphs(lines);
    expect(paras.map((p) => p.text)).toEqual(['Title', 'First line of a paragraph continues.', 'Second paragraph. Still second.']);
    const body = bodySize(paras);
    expect(body).toBe(11);
    expect(paras.map((p) => headingLevel(p, body))).toEqual([1, 0, 0]);
  });

  it('keeps real hyphens before capitals and numbers', () => {
    const paras = toParagraphs(toLines([frag('Covid-', 56, 700), frag('19 cases', 56, 685)]));
    expect(paras[0]!.text).toBe('Covid- 19 cases');
  });
});

describe('render scale', () => {
  it('renders at 150 dpi unless the page would exceed the pixel limits', () => {
    expect(renderScale(595, 842, 150, 50_000_000)).toBeCloseTo(150 / 72);
    const huge = renderScale(5000, 5000, 150, 24_000_000); // a poster
    expect(5000 * huge * 5000 * huge).toBeLessThanOrEqual(24_000_000 + 1);
    expect(renderScale(20000, 100, 150, 1e12) * 20000).toBeLessThanOrEqual(16_384 + 1e-6);
  });
});

describe('blocks', () => {
  it('turns Markdown into headings, styled runs, list items, code, quotes and tables', () => {
    const blocks = markdownToBlocks('# Title\n\nSome **bold** and *it* and `code` and [a link](https://x.y).\n\n1. one\n2. two\n   - nested\n\n> quoted\n\n```\nx = 1\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---\n');
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'para', 'item', 'item', 'item', 'quote', 'code', 'table', 'rule']);
    const para = blocks[1] as Extract<(typeof blocks)[number], { kind: 'para' }>;
    expect(para.runs.filter((r) => r.bold).map((r) => r.text)).toEqual(['bold']);
    expect(para.runs.filter((r) => r.italic).map((r) => r.text)).toEqual(['it']);
    expect(para.runs.filter((r) => r.code).map((r) => r.text)).toEqual(['code']);
    expect(para.runs.find((r) => r.link)).toMatchObject({ text: 'a link', link: 'https://x.y' });
    expect(blocks.slice(2, 5)).toMatchObject([
      { ordered: true, number: 1, depth: 0 },
      { ordered: true, number: 2, depth: 0 },
      { ordered: false, depth: 1 },
    ]);
    expect(blocks[7]).toMatchObject({ kind: 'table', header: true, rows: [['a', 'b'], ['1', '2']] });
  });

  it('splits plain text into paragraphs at blank lines and keeps line breaks', () => {
    expect(textToBlocks('a\nb\n\n\nc\n')).toEqual([
      { kind: 'para', runs: [{ text: 'a\nb' }] },
      { kind: 'para', runs: [{ text: 'c' }] },
    ]);
  });
});

describe('PDF writer', () => {
  it('knows which characters the standard fonts can draw', () => {
    expect(isWinAnsi('é')).toBe(true);
    expect(isWinAnsi('€')).toBe(true);
    expect(isWinAnsi('न')).toBe(false);
    const notes = { missing: new Set<string>() };
    expect(sanitize('café → नम\tx', notes)).toBe('café -> ??    x');
    expect([...notes.missing]).toEqual(['न', 'म']);
  });

  it('writes a valid PDF that flows onto more pages and repeats table headers', async () => {
    const long = Array.from({ length: 120 }, (_, i) => ({ kind: 'para' as const, runs: [{ text: `Paragraph ${i} with enough words to wrap across the page width at least once, maybe twice.` }] }));
    const table = { kind: 'table' as const, header: true, rows: [['Name', 'Value'], ...Array.from({ length: 80 }, (_, i) => [`row ${i}`, String(i)])] };
    const { data, pages, notes } = await blocksToPdf([{ kind: 'heading', level: 1, runs: [{ text: 'Report' }] }, ...long, table], { title: 'Report' });
    expect(new TextDecoder().decode(data.slice(0, 5))).toBe('%PDF-');
    expect(pages).toBeGreaterThan(3);
    expect(notes.missing.size).toBe(0);
    const doc = await PDFDocument.load(data);
    expect(doc.getPageCount()).toBe(pages);
    expect(doc.getTitle()).toBe('Report');
  });

  it('breaks a single very long word instead of overflowing', async () => {
    const { data } = await blocksToPdf([{ kind: 'para', runs: [{ text: 'x'.repeat(2000) }] }], { title: 't' });
    expect((await PDFDocument.load(data)).getPageCount()).toBe(1);
  });
});

describe('Word writer', () => {
  it('writes headings, numbered and bulleted lists, code, tables and links', async () => {
    const data = await blocksToDocx(markdownToBlocks('# Title\n\nText with **bold**.\n\n1. one\n2. two\n\n- dot\n\n```\ncode\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n[site](https://example.com)\n'), 'T');
    const zip = await JSZip.loadAsync(data);
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toContain('w:val="Heading1"');
    expect(xml).toContain('Title');
    expect(xml).toMatch(/<w:b\/>[\s\S]*bold/);
    expect(xml).toContain('<w:numPr>');
    expect(xml).toContain('<w:tbl>');
    expect(xml).toContain('Consolas');
    expect(await zip.file('word/_rels/document.xml.rels')!.async('string')).toContain('https://example.com');
  });

  it('keeps every script (Word has no font limits)', async () => {
    const zip = await JSZip.loadAsync(await blocksToDocx(textToBlocks('नमस्ते दुनिया · 你好'), 'T'));
    expect(await zip.file('word/document.xml')!.async('string')).toContain('नमस्ते दुनिया · 你好');
  });
});

describe('document → PDF and Word', () => {
  const conv = createDocumentConverter({ libraries: true });
  const run = (content: string, name: string, from: string, to: string) =>
    conv.convert({ file: new Blob([content]), name, format: getFormat(from) }, to, { quality: 1, background: '#fff' }, { signal: new AbortController().signal, onProgress: () => {} });

  it('offers PDF and Word for text and Markdown, PDF for tables', () => {
    expect(conv.outputsFor('txt')).toEqual(['pdf', 'docx', 'md', 'html']);
    expect(conv.outputsFor('md')).toEqual(['pdf', 'docx', 'html', 'txt']);
    expect(conv.outputsFor('csv')).toContain('pdf');
    expect(createDocumentConverter({ libraries: false }).outputsFor('md')).toEqual(['html', 'txt']);
  });

  it('Markdown → PDF, and explains characters the PDF fonts lack', async () => {
    const ok = await run('# Hi\n\nPlain text.', 'a.md', 'md', 'pdf');
    expect(ok.fileName).toBe('a.pdf');
    expect(ok.warnings).toEqual([]);
    const hindi = await run('नमस्ते', 'b.txt', 'txt', 'pdf');
    expect(hindi.warnings[0]).toMatch(/can't be shown with the built-in PDF fonts.*Choose Word or HTML/);
  });

  it('CSV → PDF lays out a table, landscape when wide', async () => {
    const wide = `${Array.from({ length: 9 }, (_, i) => `c${i}`).join(',')}\n${Array.from({ length: 9 }, (_, i) => i).join(',')}\n`;
    const r = await run(wide, 'w.csv', 'csv', 'pdf');
    const doc = await PDFDocument.load(await r.blob.arrayBuffer());
    const { width, height } = doc.getPage(0).getSize();
    expect(width).toBeGreaterThan(height);
  });

  it('text → Word', async () => {
    const r = await run('Hello\nthere\n\nSecond', 'n.txt', 'txt', 'docx');
    expect(r.fileName).toBe('n.docx');
    const xml = await (await JSZip.loadAsync(await r.blob.arrayBuffer())).file('word/document.xml')!.async('string');
    expect(xml).toContain('Hello');
    expect(xml).toContain('<w:br/>');
    expect(xml).toContain('Second');
  });
});

describe('PDF inspection', () => {
  it('counts pages when page objects are readable, and gives no count otherwise', async () => {
    const plain = await PDFDocument.load(await buildPdf({ textPages: SAMPLE_TEXT_PAGES }));
    const uncompressed = await plain.save({ useObjectStreams: false });
    expect((await inspectFile(new File([uncompressed as BlobPart], 'two.pdf'))).details).toBe('2 pages');
    const compressed = await buildPdf({ textPages: SAMPLE_TEXT_PAGES });
    expect((await inspectFile(new File([compressed], 'two.pdf'))).details).toBeUndefined();
  });

  it('warns about a wrong extension', async () => {
    const pdf = await buildPdf({ textPages: SAMPLE_TEXT_PAGES });
    expect((await inspectFile(new File([pdf], 'report.docx'))).warnings[0]).toMatch(/named \.docx but is actually a PDF/);
  });
});
