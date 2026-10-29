/**
 * Test PDFs built in Node with pdf-lib (the same library the app uses to
 * write PDFs), so tests don't depend on binary files checked into the repo.
 */
import { PDFDocument, StandardFonts } from 'pdf-lib';

export interface PdfSpec {
  /** Text pages: a heading, then paragraphs separated by blank lines. */
  textPages?: { heading: string; paragraphs: string[][] }[];
  /** JPEG bytes for "scanned" pages: one full-page image each, no text. */
  scans?: Uint8Array[];
}

export async function buildPdf(spec: PdfSpec): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const p of spec.textPages ?? []) {
    const page = doc.addPage([595, 842]);
    page.drawText(p.heading, { x: 56, y: 760, size: 22, font: bold });
    let y = 720;
    for (const para of p.paragraphs) {
      for (const line of para) {
        page.drawText(line, { x: 56, y, size: 11, font: regular });
        y -= 15;
      }
      y -= 12; // paragraph gap
    }
  }
  for (const jpeg of spec.scans ?? []) {
    const img = await doc.embedJpg(jpeg);
    const page = doc.addPage([595, 842]);
    page.drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
  }
  return Buffer.from(await doc.save());
}

export const SAMPLE_TEXT_PAGES = [
  {
    heading: 'Chapter One',
    paragraphs: [
      ['OpenConverter turns PDF pages into images,', 'text and Word documents on your device.'],
      ['A second paragraph starts here and', 'continues on the next line.'],
    ],
  },
  { heading: 'Chapter Two', paragraphs: [['The second page has its own text.']] },
];
