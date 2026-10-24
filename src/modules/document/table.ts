/**
 * Tables shared by the data conversions (JSON, CSV, Excel, Markdown and
 * HTML tables). A sheet is a name plus rows of cells; when a sheet has a
 * header, it is the first row.
 */

export type Cell = string | number | boolean | null;

export interface Sheet {
  name: string;
  rows: Cell[][];
}

export interface TableNotes {
  /** Some values were objects or arrays and were written as JSON text. */
  nested: boolean;
  /** The data came from one property of a wrapping object, e.g. { "data": [...] }. */
  unwrapped?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function toCell(v: unknown, notes: TableNotes): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  notes.nested = true;
  return JSON.stringify(v);
}

function rowsFromValue(value: unknown, notes: TableNotes): Cell[][] {
  if (Array.isArray(value)) {
    if (value.length && value.every(isRecord)) {
      const header: string[] = [];
      const seen = new Set<string>();
      for (const obj of value) for (const k of Object.keys(obj)) if (!seen.has(k)) seen.add(k), header.push(k);
      return [header, ...value.map((obj) => header.map((k) => toCell(obj[k], notes)))];
    }
    if (value.length && value.every(Array.isArray)) return (value as unknown[][]).map((r) => r.map((c) => toCell(c, notes)));
    return [['value'], ...value.map((v) => [toCell(v, notes)])];
  }
  if (isRecord(value)) {
    return [['key', 'value'], ...Object.entries(value).map(([k, v]) => [k, toCell(v, notes)])];
  }
  return [['value'], [toCell(value, notes)]];
}

/**
 * Turn parsed JSON into sheets:
 * - an array of objects becomes one table, with a column per key;
 * - an object whose values are all arrays becomes one sheet per key (this is
 *   also what an Excel workbook with several sheets turns into);
 * - an object wrapping a single array, like { "data": [...] }, uses the array;
 * - anything else becomes a key/value or single-column table.
 */
export function jsonToSheets(value: unknown): { sheets: Sheet[]; notes: TableNotes } {
  const notes: TableNotes = { nested: false };
  if (isRecord(value)) {
    const entries = Object.entries(value);
    const arrays = entries.filter(([, v]) => Array.isArray(v));
    if (entries.length > 1 && arrays.length === entries.length) {
      return { sheets: entries.map(([name, v]) => ({ name, rows: rowsFromValue(v, notes) })), notes };
    }
    if (arrays.length === 1 && entries.length === 1) {
      const [name, v] = arrays[0]!;
      notes.unwrapped = name;
      return { sheets: [{ name, rows: rowsFromValue(v, notes) }], notes };
    }
  }
  return { sheets: [{ name: 'Sheet1', rows: rowsFromValue(value, notes) }], notes };
}

/** Header names made unique and non-empty: "", "a", "a" -> "column_1", "a", "a_2". */
export function headerNames(row: readonly Cell[]): string[] {
  const used = new Map<string, number>();
  return row.map((c, i) => {
    let name = c === null || c === '' ? `column_${i + 1}` : String(c);
    const n = used.get(name) ?? 0;
    used.set(name, n + 1);
    if (n) name = `${name}_${n + 1}`;
    return name;
  });
}

/** Rows (first row = header) as an array of objects. Fully empty rows are skipped. */
export function sheetToObjects(rows: readonly Cell[][]): Record<string, Cell>[] {
  if (!rows.length) return [];
  const header = headerNames(rows[0]!);
  return rows
    .slice(1)
    .filter((r) => r.some((c) => c !== null && c !== ''))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? null])));
}

/**
 * Turn CSV text into a typed value: plain numbers become numbers and
 * true/false become booleans. Numbers with leading zeros (phone numbers, IDs,
 * postcodes) and very long digit strings stay text, so nothing is mangled.
 */
export function coerce(s: string): Cell {
  if (/^-?(0|[1-9]\d{0,14})(\.\d+)?$/.test(s)) return Number(s);
  if (s === 'true' || s === 'TRUE') return true;
  if (s === 'false' || s === 'FALSE') return false;
  return s;
}

export function cellText(c: Cell): string {
  if (c === null) return '';
  return typeof c === 'string' ? c : String(c);
}

/** Pad every row to the widest row, so tables are rectangular. */
export function rectangular(rows: readonly Cell[][]): Cell[][] {
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  return rows.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? null));
}

const mdCell = (c: Cell) => cellText(c).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');

/** A GitHub-flavoured Markdown table; the first row is the header. */
export function toMarkdownTable(rows: readonly Cell[][]): string {
  const r = rectangular(rows);
  if (!r.length || !r[0]!.length) return '';
  const line = (row: Cell[]) => `| ${row.map(mdCell).join(' | ')} |`;
  return [line(r[0]!), `| ${r[0]!.map(() => '---').join(' | ')} |`, ...r.slice(1).map(line)].join('\n') + '\n';
}

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** An HTML table; the first row is the header. All text is escaped. */
export function toHtmlTable(rows: readonly Cell[][]): string {
  const r = rectangular(rows);
  if (!r.length) return '<table></table>';
  const cells = (row: Cell[], tag: string) => row.map((c) => `<${tag}>${escapeHtml(cellText(c))}</${tag}>`).join('');
  return `<table>\n<thead><tr>${cells(r[0]!, 'th')}</tr></thead>\n<tbody>\n${r
    .slice(1)
    .map((row) => `<tr>${cells(row, 'td')}</tr>`)
    .join('\n')}\n</tbody>\n</table>`;
}

/** A complete, standalone HTML page with light, readable styling. */
export function htmlDocument(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body { font: 16px/1.6 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; max-width: 48rem; margin: 2rem auto; padding: 0 1rem; color: #111; }
table { border-collapse: collapse; margin: 1rem 0; }
th, td { border: 1px solid #ccc; padding: 0.3rem 0.6rem; text-align: left; vertical-align: top; }
th { background: #f4f4f4; }
pre { background: #f4f4f4; padding: 1rem; overflow: auto; }
code { font-family: ui-monospace, Menlo, Consolas, monospace; }
img { max-width: 100%; }
blockquote { margin-left: 0; padding-left: 1rem; border-left: 3px solid #ccc; color: #444; }
</style>
</head>
<body>
${body}
</body>
</html>
`;
}
