/**
 * CSV reading and writing (RFC 4180): quoted fields may contain the
 * delimiter, line breaks and doubled quotes. Works for comma, semicolon,
 * tab and pipe separated files.
 */
import { detectDelimiter } from './text';

export function parseCsv(text: string, delimiter = detectDelimiter(text, 1) ?? ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const n = text.length;
  // Skip a byte-order mark.
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  while (i < n) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      i++;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
      i++;
    } else if (ch === '\n' || ch === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      field += ch;
      i++;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  // Drop blank lines (a single empty field).
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

function quote(value: string, delimiter: string): string {
  return /["\r\n]/.test(value) || value.includes(delimiter) || /^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Write rows as CSV with CRLF line endings, as RFC 4180 and Excel expect. */
export function toCsv(rows: readonly (readonly string[])[], delimiter = ','): string {
  return rows.map((r) => r.map((v) => quote(v, delimiter)).join(delimiter)).join('\r\n') + '\r\n';
}
