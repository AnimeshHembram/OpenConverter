/**
 * Lay out blocks as a real PDF with selectable text, using pdf-lib (MIT) and
 * the standard PDF fonts (Helvetica, Courier). Loaded only when needed.
 *
 * The standard fonts cover Western European text (Windows-1252). Characters
 * outside it (e.g. Devanagari, Chinese, emoji) can't be drawn with them; they
 * are replaced and the user is told, rather than silently producing a broken
 * file. Embedding Unicode fonts would add several MB per script.
 */
import type { PDFFont, PDFPage } from 'pdf-lib';
import { ConversionError } from '../../core/errors';
import type { Block, Run } from './blocks';

type PdfLib = typeof import('pdf-lib');
let lib: Promise<PdfLib> | null = null;

export async function loadPdfLib(): Promise<PdfLib> {
  lib ??= import('pdf-lib');
  try {
    return await lib;
  } catch (e) {
    lib = null;
    throw new ConversionError('ENCODER_LOAD_FAILED', "OpenConverter's PDF writer couldn't be loaded. Check your internet connection and try again.", { cause: e });
  }
}

// ---- Character coverage ------------------------------------------------------

const WIN_ANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
const REPLACEMENTS: Record<string, string> = {
  '☐': '[ ]', '☑': '[x]', '☒': '[x]', '→': '->', '←': '<-', '⇒': '=>', '−': '-', '≤': '<=', '≥': '>=', '≠': '!=',
  '✓': 'v', '✔': 'v', '​': '', '﻿': '', ' ': ' ', ' ': ' ', '‐': '-', '‑': '-', '′': "'", '″': '"',
};

export function isWinAnsi(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WIN_ANSI_EXTRA.includes(ch);
}

export interface PdfNotes {
  /** Characters the standard fonts can't draw, which were replaced with "?". */
  missing: Set<string>;
}

/** Make text drawable with the standard fonts: tabs to spaces, known look-alikes swapped, the rest "?". */
export function sanitize(text: string, notes: PdfNotes): string {
  let out = '';
  for (const ch of text.replace(/\t/g, '    ')) {
    if (ch === '\n' || isWinAnsi(ch)) out += ch;
    else if (ch in REPLACEMENTS) out += REPLACEMENTS[ch];
    else if (/\s/.test(ch)) out += ' ';
    else {
      notes.missing.add(ch);
      out += '?';
    }
  }
  return out;
}

// ---- Layout -----------------------------------------------------------------------

export interface PdfLayoutOptions {
  title: string;
  /** Landscape A4, for wide tables. */
  landscape?: boolean;
}

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 56;
const BODY = 11;
const HEADING_SIZES = [20, 16, 13.5, 12, 11, 11];

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  boldItalic: PDFFont;
  mono: PDFFont;
}

interface Piece {
  text: string;
  font: PDFFont;
  width: number;
  link?: string;
}

export async function blocksToPdf(blocks: readonly Block[], opts: PdfLayoutOptions): Promise<{ data: Uint8Array; notes: PdfNotes; pages: number }> {
  const { PDFDocument, StandardFonts, rgb } = await loadPdfLib();
  const doc = await PDFDocument.create();
  doc.setTitle(opts.title);
  doc.setProducer('OpenConverter');
  doc.setCreator('OpenConverter');
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
    mono: await doc.embedFont(StandardFonts.Courier),
  };
  const notes: PdfNotes = { missing: new Set() };
  const size: [number, number] = opts.landscape ? [A4[1], A4[0]] : A4;
  const width = size[0] - MARGIN * 2;
  const ink = rgb(0.07, 0.07, 0.07);
  const muted = rgb(0.35, 0.35, 0.35);
  const shade = rgb(0.95, 0.95, 0.95);
  const line = rgb(0.75, 0.75, 0.75);

  let page: PDFPage = doc.addPage(size);
  let y = size[1] - MARGIN; // top of the next line
  const newPage = () => {
    page = doc.addPage(size);
    y = size[1] - MARGIN;
  };
  const ensure = (h: number) => {
    if (y - h < MARGIN) newPage();
  };

  const fontFor = (r: Run) => (r.code ? fonts.mono : r.bold && r.italic ? fonts.boldItalic : r.bold ? fonts.bold : r.italic ? fonts.italic : fonts.regular);

  /** Break styled runs into lines no wider than `max`. */
  const wrap = (runs: readonly Run[], fontSize: number, max: number, base?: Partial<Run>): Piece[][] => {
    const lines: Piece[][] = [[]];
    let used = 0;
    const push = (p: Piece) => {
      lines[lines.length - 1]!.push(p);
      used += p.width;
    };
    for (const run of runs) {
      const style = { ...base, ...run };
      const font = fontFor(style);
      const text = sanitize(run.text, notes);
      for (const part of text.split(/(\n| +)/)) {
        if (part === '') continue;
        if (part === '\n') {
          lines.push([]);
          used = 0;
          continue;
        }
        const w = font.widthOfTextAtSize(part, fontSize);
        if (/^ +$/.test(part)) {
          if (used > 0) push({ text: part, font, width: w, link: style.link });
          continue;
        }
        if (used + w <= max) {
          push({ text: part, font, width: w, link: style.link });
          continue;
        }
        // Doesn't fit: drop trailing spaces, start a new line.
        const cur = lines[lines.length - 1]!;
        while (cur.length && /^ +$/.test(cur[cur.length - 1]!.text)) cur.pop();
        if (cur.length) {
          lines.push([]);
          used = 0;
        }
        if (w <= max) {
          push({ text: part, font, width: w, link: style.link });
          continue;
        }
        // A single word longer than the line: split it by characters.
        let chunk = '';
        for (const ch of part) {
          if (font.widthOfTextAtSize(chunk + ch, fontSize) > max && chunk) {
            push({ text: chunk, font, width: font.widthOfTextAtSize(chunk, fontSize) });
            lines.push([]);
            used = 0;
            chunk = '';
          }
          chunk += ch;
        }
        if (chunk) push({ text: chunk, font, width: font.widthOfTextAtSize(chunk, fontSize), link: style.link });
      }
    }
    return lines;
  };

  const drawLines = (lines: Piece[][], fontSize: number, x: number, lineHeight: number, color = ink, decorate?: (top: number) => void) => {
    for (const l of lines) {
      ensure(lineHeight);
      decorate?.(y);
      let cx = x;
      for (const p of l) {
        page.drawText(p.text, { x: cx, y: y - fontSize, size: fontSize, font: p.font, color });
        cx += p.width;
      }
      y -= lineHeight;
    }
  };

  const paragraph = (runs: Run[], fontSize: number, indent = 0, color = ink, base?: Partial<Run>, decorate?: (top: number) => void) => {
    drawLines(wrap(runs, fontSize, width - indent, base), fontSize, MARGIN + indent, fontSize * 1.4, color, decorate);
  };

  for (const b of blocks) {
    switch (b.kind) {
      case 'heading': {
        const s = HEADING_SIZES[Math.min(5, b.level - 1)]!;
        y -= s * 0.6;
        ensure(s * 2.6); // keep a heading with at least one following line
        paragraph(b.runs, s, 0, ink, { bold: true });
        y -= 3;
        break;
      }
      case 'para':
        paragraph(b.runs, BODY);
        y -= BODY * 0.55;
        break;
      case 'item': {
        const indent = 18 * (b.depth + 1);
        const marker = b.ordered ? `${b.number}.` : '•';
        const lines = wrap(b.runs, BODY, width - indent);
        ensure(BODY * 1.4);
        const mw = fonts.regular.widthOfTextAtSize(marker, BODY);
        page.drawText(marker, { x: MARGIN + indent - 6 - mw, y: y - BODY, size: BODY, font: fonts.regular, color: ink });
        drawLines(lines, BODY, MARGIN + indent, BODY * 1.4);
        y -= BODY * 0.25;
        break;
      }
      case 'code': {
        const s = 9.5;
        const lh = s * 1.45;
        const lines = wrap([{ text: b.text, code: true }], s, width - 16);
        y -= 2;
        drawLines(lines, s, MARGIN + 8, lh, ink, (top) => page.drawRectangle({ x: MARGIN, y: top - lh, width, height: lh, color: shade }));
        y -= BODY * 0.7;
        break;
      }
      case 'quote':
        paragraph(b.runs, BODY, 16, muted, { italic: true }, (top) =>
          page.drawLine({ start: { x: MARGIN + 4, y: top }, end: { x: MARGIN + 4, y: top - BODY * 1.4 }, thickness: 2, color: line }),
        );
        y -= BODY * 0.55;
        break;
      case 'rule':
        ensure(14);
        y -= 7;
        page.drawLine({ start: { x: MARGIN, y }, end: { x: MARGIN + width, y }, thickness: 0.75, color: line });
        y -= 7;
        break;
      case 'pagebreak':
        newPage();
        break;
      case 'table':
        drawTable(b.rows, b.header);
        y -= BODY * 0.8;
        break;
    }
  }

  function drawTable(rows: string[][], header: boolean) {
    if (!rows.length) return;
    const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
    if (!cols) return;
    const s = cols > 8 ? 7.5 : 9;
    const pad = 4;
    const lh = s * 1.3;
    // Column widths from content, capped, then scaled to the page width.
    const natural = Array.from({ length: cols }, (_, c) =>
      Math.min(220, Math.max(24, ...rows.slice(0, 200).map((r, i) => (i === 0 && header ? fonts.bold : fonts.regular).widthOfTextAtSize(sanitize(r[c] ?? '', notes).split('\n')[0]!, s) + pad * 2))),
    );
    const total = natural.reduce((a, b) => a + b, 0);
    const widths = natural.map((w) => (total > width ? (w / total) * width : w));
    const cellLines = (r: string[], bold: boolean) => widths.map((w, c) => wrap([{ text: r[c] ?? '', bold }], s, w - pad * 2));
    const drawRow = (r: string[], bold: boolean) => {
      const cells = cellLines(r, bold);
      const h = Math.max(1, ...cells.map((l) => l.length)) * lh + pad * 2;
      ensure(h);
      let x = MARGIN;
      cells.forEach((lines, c) => {
        page.drawRectangle({ x, y: y - h, width: widths[c]!, height: h, borderColor: line, borderWidth: 0.5, color: bold ? shade : undefined });
        lines.forEach((l, i) => {
          let cx = x + pad;
          for (const p of l) {
            page.drawText(p.text, { x: cx, y: y - pad - s - i * lh, size: s, font: p.font, color: ink });
            cx += p.width;
          }
        });
        x += widths[c]!;
      });
      y -= h;
      return h;
    };
    const head = header ? rows[0]! : null;
    for (let i = header ? 1 : 0; i < rows.length; i++) {
      if (i === (header ? 1 : 0) && head) drawRow(head, true);
      const r = rows[i]!;
      const cells = cellLines(r, false);
      const h = Math.max(1, ...cells.map((l) => l.length)) * lh + pad * 2;
      if (y - h < MARGIN) {
        newPage();
        if (head) drawRow(head, true); // repeat the header on each page
      }
      drawRow(r, false);
    }
    if (header && rows.length === 1) drawRow(rows[0]!, true);
  }

  const data = await doc.save({ useObjectStreams: true });
  return { data, notes, pages: doc.getPageCount() };
}
