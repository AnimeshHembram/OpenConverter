/**
 * Turning file bytes into text, and recognising which kind of text it is
 * (JSON, CSV, Markdown or plain text). Text formats have no magic bytes, so
 * the content decides where it can, with the file extension as a hint.
 */

export interface DecodedText {
  text: string;
  /** Set when the bytes weren't UTF-8 and another encoding was used. */
  encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';
}

/**
 * Decode text bytes: a UTF-8 or UTF-16 byte-order mark wins, then strict
 * UTF-8, then Windows-1252 (what older Windows apps such as Excel write).
 * A UTF-8 BOM is dropped from the text.
 */
export function decodeText(bytes: Uint8Array): DecodedText {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' };
  const body = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(body), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(body), encoding: 'windows-1252' };
  }
}

/**
 * Whether bytes look like text rather than binary data: no NUL bytes (unless
 * UTF-16 with a BOM) and few control characters.
 */
export function looksLikeText(bytes: Uint8Array): boolean {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return true;
  const n = Math.min(bytes.length, 64 * 1024);
  if (n === 0) return false;
  let control = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i]!;
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32 && b !== 27)) control++;
  }
  return control / n < 0.01;
}

export type TextKind = 'json' | 'csv' | 'md' | 'txt';

/** Strip a JSON parse error down to something readable. */
export function jsonProblem(text: string): string | null {
  try {
    JSON.parse(text);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const MD_PATTERNS = [
  /^#{1,6}\s+\S/m, // heading
  /^```/m, // code fence
  /^\s*[-*+]\s+\S/m, // bullet list
  /^\s*\d+\.\s+\S/m, // numbered list
  /\[[^\]\n]+\]\([^)\s]+\)/, // link
  /(\*\*|__)[^*_\n]+\1/, // bold
  /^>\s+\S/m, // quote
  /^\|.+\|\s*$/m, // table row
];

/** How many distinct Markdown features the text uses. */
export function markdownScore(text: string): number {
  const sample = text.slice(0, 64 * 1024);
  return MD_PATTERNS.reduce((n, re) => n + (re.test(sample) ? 1 : 0), 0);
}

/**
 * Pick the delimiter that splits the first lines into the same number of
 * fields (at least two). Quoted fields are respected. Returns null when no
 * candidate is consistent.
 */
export function detectDelimiter(text: string, minLines = 2): string | null {
  const lines = text.slice(0, 64 * 1024).split(/\r\n|\n|\r/).filter((l) => l.trim() !== '').slice(0, 20);
  if (lines.length < minLines) return null;
  let best: { d: string; fields: number } | null = null;
  for (const d of [',', '\t', ';', '|']) {
    const counts = lines.map((l) => countFields(l, d));
    const first = counts[0]!;
    if (first < 2 || !counts.every((c) => c === first)) continue;
    if (!best || first > best.fields) best = { d, fields: first };
  }
  return best?.d ?? null;
}

function countFields(line: string, d: string): number {
  let n = 1;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === d && !quoted) n++;
  }
  return n;
}

/**
 * Decide what kind of text a file holds. The extension is trusted for CSV
 * and Markdown; JSON is recognised by parsing; plain .txt files only become
 * CSV or Markdown when the content is unambiguous.
 */
export function classifyText(text: string, extension: string): TextKind {
  const ext = extension.toLowerCase();
  const trimmed = text.trimStart();
  if (ext === 'json' || ((trimmed.startsWith('{') || trimmed.startsWith('[')) && jsonProblem(text) === null)) return 'json';
  if (ext === 'csv' || ext === 'tsv') return 'csv';
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'txt' || ext === 'text' || ext === 'log') {
    if (detectDelimiter(text, 5)) return 'csv';
    return markdownScore(text) >= 3 ? 'md' : 'txt';
  }
  if (detectDelimiter(text, 3)) return 'csv';
  return markdownScore(text) >= 2 ? 'md' : 'txt';
}
