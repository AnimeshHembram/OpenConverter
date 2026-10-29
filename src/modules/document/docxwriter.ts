/**
 * Write blocks as a Word document (.docx) with real headings, lists, tables
 * and styled text, using the `docx` library (MIT). Loaded only when needed.
 * The files open in Microsoft Word, Google Docs, Pages and LibreOffice.
 */
import { ConversionError } from '../../core/errors';
import type { Block, Run } from './blocks';

type Docx = typeof import('docx');
let lib: Promise<Docx> | null = null;

async function load(): Promise<Docx> {
  lib ??= import('docx');
  try {
    return await lib;
  } catch (e) {
    lib = null;
    throw new ConversionError('ENCODER_LOAD_FAILED', "OpenConverter's Word writer couldn't be loaded. Check your internet connection and try again.", { cause: e });
  }
}

// Word refuses XML-invalid control characters.
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '');

export async function blocksToDocx(blocks: readonly Block[], title: string): Promise<Uint8Array> {
  const d = await load();
  const MONO = 'Consolas';

  type Child = InstanceType<Docx['TextRun']> | InstanceType<Docx['ExternalHyperlink']>;
  const runs = (rs: readonly Run[], base: { italic?: boolean } = {}): Child[] =>
    rs.flatMap((r): Child[] => {
      const parts = clean(r.text).split('\n');
      const make = (text: string, i: number) =>
        new d.TextRun({ text, bold: r.bold, italics: r.italic || base.italic, font: r.code ? MONO : undefined, break: i > 0 ? 1 : undefined });
      const textRuns = parts.map(make);
      return r.link && /^(https?:|mailto:)/i.test(r.link) ? [new d.ExternalHyperlink({ link: r.link, children: textRuns.map((_, i) => new d.TextRun({ text: parts[i]!, style: 'Hyperlink', break: i > 0 ? 1 : undefined })) })] : textRuns;
    });

  const HEADINGS = [d.HeadingLevel.HEADING_1, d.HeadingLevel.HEADING_2, d.HeadingLevel.HEADING_3, d.HeadingLevel.HEADING_4, d.HeadingLevel.HEADING_5, d.HeadingLevel.HEADING_6];
  const children: (InstanceType<Docx['Paragraph']> | InstanceType<Docx['Table']>)[] = [];
  let listInstance = 0;
  let prevWasOrdered = false;

  for (const b of blocks) {
    if (b.kind !== 'item') prevWasOrdered = false;
    switch (b.kind) {
      case 'heading':
        children.push(new d.Paragraph({ heading: HEADINGS[Math.min(5, b.level - 1)], children: runs(b.runs) }));
        break;
      case 'para':
        children.push(new d.Paragraph({ children: runs(b.runs) }));
        break;
      case 'quote':
        children.push(new d.Paragraph({ children: runs(b.runs, { italic: true }), indent: { left: 567 } }));
        break;
      case 'item':
        if (b.ordered) {
          // Each separate numbered list restarts at its own start number.
          if (!prevWasOrdered && b.depth === 0) listInstance++;
          prevWasOrdered = true;
          children.push(new d.Paragraph({ children: runs(b.runs), numbering: { reference: 'numbered', level: Math.min(8, b.depth), instance: listInstance } }));
        } else {
          children.push(new d.Paragraph({ children: runs(b.runs), bullet: { level: Math.min(8, b.depth) } }));
        }
        break;
      case 'code':
        for (const line of clean(b.text).split('\n')) {
          children.push(new d.Paragraph({ children: [new d.TextRun({ text: line, font: MONO, size: 19 })], shading: { type: d.ShadingType.CLEAR, fill: 'F2F2F2', color: 'auto' }, spacing: { after: 0 } }));
        }
        children.push(new d.Paragraph({ children: [] }));
        break;
      case 'table': {
        const cols = b.rows.reduce((m, r) => Math.max(m, r.length), 0);
        if (!cols) break;
        children.push(
          new d.Table({
            width: { size: 100, type: d.WidthType.PERCENTAGE },
            rows: b.rows.map(
              (r, i) =>
                new d.TableRow({
                  tableHeader: b.header && i === 0,
                  children: Array.from({ length: cols }, (_, c) =>
                    new d.TableCell({ children: [new d.Paragraph({ children: [new d.TextRun({ text: clean(r[c] ?? ''), bold: b.header && i === 0 })] })] }),
                  ),
                }),
            ),
          }),
        );
        children.push(new d.Paragraph({ children: [] }));
        break;
      }
      case 'rule':
        children.push(new d.Paragraph({ children: [], border: { bottom: { style: d.BorderStyle.SINGLE, size: 6, color: 'BFBFBF', space: 1 } } }));
        break;
      case 'pagebreak':
        children.push(new d.Paragraph({ children: [new d.PageBreak()] }));
        break;
    }
  }

  const doc = new d.Document({
    title: clean(title),
    creator: 'OpenConverter',
    numbering: {
      config: [
        {
          reference: 'numbered',
          levels: Array.from({ length: 9 }, (_, level) => ({
            level,
            format: d.LevelFormat.DECIMAL,
            text: `%${level + 1}.`,
            alignment: d.AlignmentType.START,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        },
      ],
    },
    sections: [{ children: children.length ? children : [new d.Paragraph({ children: [] })] }],
  });
  const blob = await d.Packer.toBlob(doc);
  return new Uint8Array(await blob.arrayBuffer());
}
