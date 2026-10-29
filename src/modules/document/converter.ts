/**
 * Text and data conversions: plain text, Markdown, JSON, CSV and Excel.
 * Everything runs in the page; the Excel library loads only when needed.
 */
import { parseCsv, toCsv } from '../../core/csv';
import { ConversionError, throwIfAborted } from '../../core/errors';
import { outputFileName, stripExtension } from '../../core/filename';
import { getFormat } from '../../core/formats';
import { decodeText, detectDelimiter } from '../../core/text';
import type { ConversionContext, ConversionInput, ConversionResult, Converter, FormatInfo } from '../../core/types';
import { officeKind, zipEntryNames } from '../../core/zipdir';
import { markdownToHtml, markdownToText, textToHtml, textToMarkdown } from './markdown';
import { markdownToBlocks, textToBlocks, type Block } from './blocks';
import { blocksToDocx } from './docxwriter';
import { blocksToPdf } from './pdfwriter';
import { coerce, htmlDocument, escapeHtml, jsonToSheets, rectangular, sheetToObjects, toHtmlTable, toMarkdownTable, cellText, type Cell, type Sheet } from './table';
import { readWorkbook, writeWorkbook } from './xlsx';

/** Outputs per input format. The first one is the default choice. */
export const DOCUMENT_OUTPUTS: Readonly<Record<string, readonly string[]>> = {
  txt: ['pdf', 'docx', 'md', 'html'],
  md: ['pdf', 'docx', 'html', 'txt'],
  json: ['csv', 'xlsx', 'md'],
  csv: ['xlsx', 'json', 'pdf', 'md', 'html'],
  xlsx: ['csv', 'json', 'pdf', 'md', 'html'],
};

/** Outputs (and inputs) that need a lazily loaded library: Excel, PDF and Word writers. */
const NEEDS_LIBRARY = new Set(['xlsx', 'pdf', 'docx']);

export interface DocumentConverterOptions {
  /**
   * False in the standalone file opened from disk: browsers won't load the
   * separate library files from there, so Excel, PDF and Word aren't offered.
   */
  libraries: boolean;
}

const UTF8_BOM = '﻿';

/** Check the output before offering it, as the image converter does. */
export async function verifyDocument(blob: Blob, target: FormatInfo, fileName: string): Promise<Blob> {
  if (!fileName.toLowerCase().endsWith(`.${target.extensions[0]}`)) {
    throw new ConversionError('ENCODE_FAILED', `Internal error: "${fileName}" doesn't match the ${target.label} format, so it was not saved.`);
  }
  if (target.id === 'xlsx' || target.id === 'docx') {
    const names = await zipEntryNames(blob);
    if (!names || officeKind(names) !== target.id) throw new ConversionError('ENCODE_FAILED', `The ${target.label} file couldn't be created correctly, so it was not saved.`);
  } else if (target.id === 'zip') {
    if (!(await zipEntryNames(blob))?.length) throw new ConversionError('ENCODE_FAILED', "The ZIP file couldn't be created correctly, so it was not saved.");
  } else if (target.id === 'pdf') {
    const head = new TextDecoder('latin1').decode(await blob.slice(0, 8).arrayBuffer());
    const tail = new TextDecoder('latin1').decode(await blob.slice(Math.max(0, blob.size - 1024)).arrayBuffer());
    if (!head.startsWith('%PDF-') || !tail.includes('%%EOF')) throw new ConversionError('ENCODE_FAILED', "The PDF couldn't be created correctly, so it was not saved.");
  } else {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(await blob.arrayBuffer());
    } catch {
      throw new ConversionError('ENCODE_FAILED', `The ${target.label} file couldn't be created correctly, so it was not saved.`);
    }
    if (target.id === 'json') {
      try {
        JSON.parse(text);
      } catch {
        throw new ConversionError('ENCODE_FAILED', "The JSON file couldn't be created correctly, so it was not saved.");
      }
    }
  }
  return blob.type === target.mime ? blob : new Blob([blob], { type: target.mime });
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Explain characters the standard PDF fonts can't draw. */
export function missingCharsNote(missing: ReadonlySet<string>): string {
  const sample = [...missing].slice(0, 8).join(' ');
  return `Some characters (${sample}${missing.size > 8 ? ' …' : ''}) can't be shown with the built-in PDF fonts, which cover Western European text, so they appear as "?". Choose Word or HTML to keep them.`;
}

export function createDocumentConverter(opts: DocumentConverterOptions): Converter {
  const available = (id: string) => opts.libraries || !NEEDS_LIBRARY.has(id);
  return {
    id: 'document-text',
    category: 'document',

    outputsFor(fromId) {
      if (!available(fromId)) return [];
      return (DOCUMENT_OUTPUTS[fromId] ?? []).filter(available);
    },

    unavailableReason(fromId) {
      if (fromId === 'xlsx' && !opts.libraries) {
        return 'Excel files can only be converted on the OpenConverter website or with "npm start", not in the single file opened from disk.';
      }
      return undefined;
    },

    async convert(input: ConversionInput, toId: string, _options, ctx: ConversionContext): Promise<ConversionResult> {
      const from = input.format.id;
      if (!(DOCUMENT_OUTPUTS[from] ?? []).includes(toId) || !available(toId)) {
        throw new ConversionError('NO_CONVERTER', `Converting ${input.format.label} to ${getFormat(toId).label} isn't available.`);
      }
      const target = getFormat(toId);
      const title = stripExtension(input.name);
      const warnings: string[] = [];
      ctx.onProgress({ fraction: 0.1, stage: 'Reading' });

      // ---- Read the input into text or sheets -----------------------------
      let text = '';
      let sheets: Sheet[] = [];
      if (from === 'xlsx') {
        sheets = await readWorkbook(await input.file.arrayBuffer());
        if (!sheets.length) throw new ConversionError('DECODE_FAILED', 'This workbook has no sheets.');
      } else {
        text = decodeText(new Uint8Array(await input.file.arrayBuffer())).text;
      }
      throwIfAborted(ctx.signal);
      ctx.onProgress({ fraction: 0.4, stage: 'Converting' });

      if (from === 'csv') {
        const rows = parseCsv(text, detectDelimiter(text, 1) ?? ',');
        sheets = [{ name: title, rows: rows.map((r) => r.map(coerce)) }];
      } else if (from === 'json') {
        const parsed = jsonToSheets(JSON.parse(text));
        sheets = parsed.sheets;
        if (parsed.notes.unwrapped) warnings.push(`The table was taken from the "${parsed.notes.unwrapped}" list in the JSON.`);
        if (parsed.notes.nested) warnings.push('Some values were nested objects or lists; they were written as JSON text in their cells.');
      }

      // ---- Write the output -----------------------------------------------
      /** The source as headings, paragraphs and tables, for the PDF and Word writers. */
      const toBlocks = (): Block[] => {
        if (from === 'md') return markdownToBlocks(text);
        if (from === 'txt') return textToBlocks(text);
        // Tables: one section per sheet, with the sheet name as a heading when there are several.
        return sheets.flatMap((sh, i) => {
          const out: Block[] = [];
          if (i > 0) out.push({ kind: 'pagebreak' });
          if (sheets.length > 1) out.push({ kind: 'heading', level: 2, runs: [{ text: sh.name }] });
          out.push({ kind: 'table', header: sh.rows.length > 1, rows: rectangular(sh.rows).map((r) => r.map(cellText)) });
          return out;
        });
      };
      let out: string | Uint8Array;
      const tableSheets = sheets.filter((s) => s.rows.length);
      const firstOnly = (what: string) => {
        if (sheets.length > 1) {
          warnings.push(
            `This ${from === 'xlsx' ? 'workbook' : 'data'} has ${plural(sheets.length, 'sheet')}. ${what} holds one table, so only the first, "${sheets[0]!.name}", was converted. Choose JSON, Excel, Markdown or HTML to keep every sheet.`,
          );
        }
      };
      const sections = (render: (rows: Cell[][]) => string, heading: (name: string) => string) =>
        sheets.length === 1 ? render(sheets[0]!.rows) : sheets.map((s) => `${heading(s.name)}${render(s.rows)}`).join('\n');

      switch (`${from}>${toId}`) {
        case 'txt>md':
          out = textToMarkdown(text);
          break;
        case 'txt>html':
          out = textToHtml(text, title);
          break;
        case 'md>html':
          out = markdownToHtml(text, title);
          break;
        case 'md>txt':
          out = markdownToText(text);
          break;
        case 'csv>json':
          out = JSON.stringify(sheetToObjects(sheets[0]!.rows), null, 2) + '\n';
          break;
        case 'xlsx>json':
          out =
            JSON.stringify(
              sheets.length === 1 ? sheetToObjects(sheets[0]!.rows) : Object.fromEntries(sheets.map((s) => [s.name, sheetToObjects(s.rows)])),
              null,
              2,
            ) + '\n';
          break;
        case 'json>csv':
        case 'xlsx>csv':
          firstOnly('CSV');
          // A byte-order mark makes Excel read the file as UTF-8 (accents, Hindi, emoji…).
          out = UTF8_BOM + toCsv(sheets[0]!.rows.map((r) => r.map(cellText)));
          break;
        case 'json>md':
        case 'csv>md':
        case 'xlsx>md':
          out = sections(toMarkdownTable, (name) => `## ${name}\n\n`) || '\n';
          break;
        case 'csv>html':
        case 'xlsx>html':
          out = htmlDocument(title, sheets.length === 1 ? toHtmlTable(sheets[0]!.rows) : sections(toHtmlTable, (name) => `<h2>${escapeHtml(name)}</h2>\n`));
          break;
        case 'txt>pdf':
        case 'md>pdf':
        case 'csv>pdf':
        case 'xlsx>pdf': {
          const blocks = toBlocks();
          const cols = sheets.reduce((m, sh) => Math.max(m, ...sh.rows.map((r) => r.length)), 0);
          const written = await blocksToPdf(blocks, { title, landscape: cols > 6 });
          if (written.notes.missing.size) warnings.push(missingCharsNote(written.notes.missing));
          out = written.data;
          break;
        }
        case 'txt>docx':
        case 'md>docx':
          out = await blocksToDocx(toBlocks(), title);
          break;
        case 'json>xlsx':
        case 'csv>xlsx': {
          const written = await writeWorkbook(tableSheets.length ? tableSheets : sheets);
          if (written.notes.truncatedCells) {
            warnings.push(`${plural(written.notes.truncatedCells, 'cell')} had more than 32,767 characters, Excel's limit, and ${written.notes.truncatedCells === 1 ? 'was' : 'were'} shortened.`);
          }
          out = written.data;
          break;
        }
        default:
          throw new ConversionError('NO_CONVERTER', `Converting ${input.format.label} to ${target.label} isn't available.`);
      }
      if (sheets.length && !tableSheets.length) warnings.push('There was no data to convert, so the result is empty.');

      throwIfAborted(ctx.signal);
      ctx.onProgress({ fraction: 0.9, stage: 'Checking' });
      const fileName = outputFileName(input.name, target.extensions[0]!);
      const blob = new Blob([out as BlobPart], { type: target.mime });
      const verified = await verifyDocument(blob, target, fileName);
      ctx.onProgress({ fraction: 1, stage: 'Done' });
      return { blob: verified, format: target, fileName, warnings };
    },
  };
}
