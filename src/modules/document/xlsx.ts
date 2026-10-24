/**
 * Excel workbooks (.xlsx) via exceljs, loaded only when a spreadsheet is
 * converted (about 250 KB compressed), so image users never download it.
 * .xlsx files open in Microsoft Excel, Google Sheets, Numbers and LibreOffice.
 */
import { ConversionError } from '../../core/errors';
import type { Cell, Sheet } from './table';

type ExcelJS = typeof import('exceljs');
let lib: Promise<ExcelJS> | null = null;

async function load(): Promise<ExcelJS> {
  lib ??= import('exceljs').then((m) => ((m as { default?: ExcelJS }).default ?? m) as ExcelJS);
  try {
    return await lib;
  } catch (e) {
    lib = null;
    throw new ConversionError(
      'ENCODER_LOAD_FAILED',
      "OpenConverter's spreadsheet reader couldn't be loaded. Check your internet connection and try again.",
      { cause: e },
    );
  }
}

/** Excel's own limits. */
export const EXCEL_MAX_ROWS = 1_048_576;
export const EXCEL_MAX_COLUMNS = 16_384;
export const EXCEL_MAX_CELL_TEXT = 32_767;

const pad = (n: number) => String(n).padStart(2, '0');

/** A date as "2026-10-24", or "2026-10-24 13:45:00" when it has a time. */
function dateText(d: Date): string {
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return time === '00:00:00' ? day : `${day} ${time}`;
}

/** Reduce an exceljs cell value to plain data: formulas give their result, links their text. */
export function cellValue(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (v instanceof Date) return dateText(v);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('formula' in o || 'sharedFormula' in o) return cellValue(o.result);
    if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((r) => r.text).join('');
    if ('text' in o) return cellValue(o.text);
    if ('error' in o) return String(o.error);
  }
  return JSON.stringify(v);
}

/** Read every worksheet as rows of plain values. Trailing empty rows and columns are dropped. */
export async function readWorkbook(data: ArrayBuffer): Promise<Sheet[]> {
  const Excel = await load();
  const wb = new Excel.Workbook();
  try {
    await wb.xlsx.load(data);
  } catch (e) {
    throw new ConversionError('DECODE_FAILED', "This Excel file couldn't be read. It may be damaged or password-protected.", { cause: e });
  }
  return wb.worksheets.map((ws) => {
    const rows: Cell[][] = [];
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      const values = row.values as unknown[];
      rows[n - 1] = values.slice(1).map(cellValue);
    });
    for (let i = 0; i < rows.length; i++) rows[i] ??= [];
    const empty = (c: Cell | undefined) => c === null || c === undefined || c === '';
    while (rows.length && rows[rows.length - 1]!.every(empty)) rows.pop();
    for (const r of rows) while (r.length && empty(r[r.length - 1])) r.pop();
    return { name: ws.name, rows };
  });
}

/** Excel sheet names: at most 31 characters, none of []:*?/\, unique. */
export function sheetNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((raw, i) => {
    let base = raw.replace(/[[\]:*?/\\]/g, '_').trim().slice(0, 31) || `Sheet${i + 1}`;
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base.slice(0, 31 - String(n).length - 1)} ${n}`;
    used.add(name.toLowerCase());
    return name;
  });
}

export interface WriteNotes {
  truncatedCells: number;
}

/**
 * Write sheets to .xlsx. The first row of each sheet is a header: bold,
 * frozen, with columns sized to their content. Text that starts with "=" is
 * stored as text, never as a formula.
 */
export async function writeWorkbook(sheets: readonly Sheet[]): Promise<{ data: Uint8Array; notes: WriteNotes }> {
  const notes: WriteNotes = { truncatedCells: 0 };
  for (const s of sheets) {
    if (s.rows.length > EXCEL_MAX_ROWS) {
      throw new ConversionError('ENCODE_FAILED', `This table has ${s.rows.length.toLocaleString('en')} rows. Excel allows at most ${EXCEL_MAX_ROWS.toLocaleString('en')}. Choose CSV instead.`);
    }
    if (s.rows.some((r) => r.length > EXCEL_MAX_COLUMNS)) {
      throw new ConversionError('ENCODE_FAILED', `This table has more than ${EXCEL_MAX_COLUMNS.toLocaleString('en')} columns, Excel's limit. Choose CSV instead.`);
    }
  }
  const Excel = await load();
  const wb = new Excel.Workbook();
  wb.creator = 'OpenConverter';
  const names = sheetNames(sheets.map((s) => s.name));
  sheets.forEach((s, i) => {
    const ws = wb.addWorksheet(names[i]);
    const widths: number[] = [];
    for (const row of s.rows) {
      ws.addRow(
        row.map((c, col) => {
          let v = c;
          if (typeof v === 'string' && v.length > EXCEL_MAX_CELL_TEXT) {
            v = v.slice(0, EXCEL_MAX_CELL_TEXT);
            notes.truncatedCells++;
          }
          widths[col] = Math.max(widths[col] ?? 0, Math.min(50, String(v ?? '').length));
          return v;
        }),
      );
    }
    if (s.rows.length > 1) {
      ws.getRow(1).font = { bold: true };
      ws.views = [{ state: 'frozen', ySplit: 1 }];
    }
    widths.forEach((w, col) => {
      ws.getColumn(col + 1).width = Math.max(8, w + 2);
    });
  });
  const buf = await wb.xlsx.writeBuffer();
  return { data: new Uint8Array(buf as ArrayBuffer), notes };
}
