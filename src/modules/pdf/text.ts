/**
 * Turning a PDF page's positioned text fragments into readable lines and
 * paragraphs. PDFs store text as runs placed at coordinates, not as
 * paragraphs, so structure is inferred from positions: fragments on the same
 * baseline form a line, and a larger vertical gap starts a new paragraph.
 * Pure functions, unit-tested without pdf.js.
 */

export interface Fragment {
  str: string;
  /** Left edge and baseline in PDF units (y grows upwards). */
  x: number;
  y: number;
  /** Advance width and font size. */
  width: number;
  size: number;
  /** pdf.js marks the end of a line explicitly when it knows. */
  eol?: boolean;
}

export interface Paragraph {
  text: string;
  /** Largest font size in the paragraph, used to spot headings. */
  size: number;
}

interface Line {
  text: string;
  y: number;
  size: number;
  end: number;
}

/** Group fragments into lines, inserting spaces where there's a visible gap. */
export function toLines(frags: readonly Fragment[]): Line[] {
  const lines: Line[] = [];
  let cur: Line | null = null;
  let newline = true;
  for (const f of frags) {
    if (f.str === '' && !f.eol) continue;
    const size = Math.abs(f.size) || 10;
    const sameLine = cur && !newline && Math.abs(f.y - cur.y) < size * 0.5;
    if (!sameLine) {
      if (cur && cur.text.trim() !== '') lines.push(cur);
      cur = { text: '', y: f.y, size, end: f.x };
    }
    const c = cur!;
    if (c.text && f.str) {
      const gap = f.x - c.end;
      const needsSpace = gap > size * 0.2 && !/\s$/.test(c.text) && !/^\s/.test(f.str);
      if (needsSpace) c.text += ' ';
    }
    c.text += f.str;
    c.size = Math.max(c.size, size);
    c.end = f.x + f.width;
    newline = !!f.eol;
  }
  if (cur && cur.text.trim() !== '') lines.push(cur);
  return lines.map((l) => ({ ...l, text: l.text.replace(/\s+$/, '') }));
}

/**
 * Join lines into paragraphs: a gap clearly bigger than normal line spacing,
 * or a change of font size, starts a new paragraph. A hyphen at the end of a
 * line followed by a lowercase letter is treated as a word split.
 */
export function toParagraphs(lines: readonly Line[]): Paragraph[] {
  if (!lines.length) return [];
  // Normal line spacing is the most common gap (ties go to the smaller one);
  // a median would be skewed by paragraph gaps on short pages.
  const gaps = lines.slice(1).map((l, i) => Math.round(lines[i]!.y - l.y)).filter((g) => g > 0);
  const counts = new Map<number, number>();
  for (const g of gaps) counts.set(g, (counts.get(g) ?? 0) + 1);
  let typical = lines[0]!.size * 1.2;
  let most = 0;
  for (const [g, n] of counts) if (n > most || (n === most && g < typical)) (typical = g), (most = n);
  const paras: Paragraph[] = [];
  let cur: Paragraph | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const prev = lines[i - 1];
    const gap = prev ? prev.y - l.y : 0;
    const sizeChange = prev && Math.abs(l.size - prev.size) > Math.max(1, prev.size * 0.15);
    const breakHere = !cur || gap > typical * 1.45 || gap < 0 || sizeChange;
    if (breakHere) {
      if (cur) paras.push(cur);
      cur = { text: l.text.trim(), size: l.size };
    } else {
      const c: Paragraph = cur!;
      if (/[A-Za-z]-$/.test(c.text) && /^[a-z]/.test(l.text.trim())) c.text = c.text.slice(0, -1) + l.text.trim();
      else c.text += ` ${l.text.trim()}`;
      c.size = Math.max(c.size, l.size);
    }
  }
  if (cur) paras.push(cur);
  return paras;
}

/** The body font size: the size used by the most characters. */
export function bodySize(paras: readonly Paragraph[]): number {
  const weight = new Map<number, number>();
  for (const p of paras) weight.set(Math.round(p.size), (weight.get(Math.round(p.size)) ?? 0) + p.text.length);
  let best = 10;
  let most = -1;
  for (const [size, n] of weight) if (n > most) (best = size), (most = n);
  return best;
}

/** Heading level for a paragraph: 1 or 2 when clearly larger than body text and short. */
export function headingLevel(p: Paragraph, body: number): 0 | 1 | 2 {
  if (p.text.length > 120) return 0;
  if (p.size >= body * 1.6) return 1;
  if (p.size >= body * 1.25) return 2;
  return 0;
}
