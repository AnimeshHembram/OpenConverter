/**
 * PDF input: pages to images, text, Markdown or Word, and compression.
 * pdf.js reads and renders; pdf-lib rebuilds PDFs; docx writes Word files.
 * All three load lazily, only when a PDF is converted.
 */
import { ConversionError, throwIfAborted } from '../../core/errors';
import { outputFileName, stripExtension } from '../../core/filename';
import { getFormat } from '../../core/formats';
import { MAX_DIMENSION, pixelPolicy } from '../../core/limits';
import type { ConversionContext, ConversionInput, ConversionResult, Converter } from '../../core/types';
import { createZip } from '../../core/zip';
import type { Block } from '../document/blocks';
import { verifyDocument } from '../document/converter';
import { blocksToDocx } from '../document/docxwriter';
import { loadPdfLib } from '../document/pdfwriter';
import { canvasToBlob } from '../image/capabilities';
import { verifyOutput } from '../image/converter';
import { openPdf, pdfjsLib, type PdfDocument, type PdfPage } from './pdfjs';
import { bodySize, headingLevel, toLines, toParagraphs, type Fragment, type Paragraph } from './text';

/** Outputs for a PDF, default first. */
export const PDF_OUTPUTS = ['png', 'jpeg', 'docx', 'txt', 'md', 'pdf'] as const;

const LABELS: Record<string, string> = {
  png: 'PNG images',
  jpeg: 'JPEG images',
  docx: 'Word (text)',
  txt: 'Text',
  md: 'Markdown',
  pdf: 'Smaller PDF',
};

/** Pages rendered at 150 dpi: sharp on screen and in print, without huge files. */
export const RENDER_DPI = 150;
/** Converting more pages than this to images at once uses too much memory and time. */
export const MAX_IMAGE_PAGES = 300;

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Scale for rendering at `dpi`, reduced if the page would exceed this device's pixel limits. */
export function renderScale(widthPt: number, heightPt: number, dpi = RENDER_DPI, maxPixels = pixelPolicy().maxPixels): number {
  let scale = dpi / 72;
  scale = Math.min(scale, MAX_DIMENSION / widthPt, MAX_DIMENSION / heightPt);
  const px = widthPt * heightPt * scale * scale;
  if (px > maxPixels) scale *= Math.sqrt(maxPixels / px);
  return scale;
}

async function renderPage(page: PdfPage, dpi = RENDER_DPI) {
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: renderScale(base.width, base.height, dpi) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const g = canvas.getContext('2d');
  if (!g || canvas.width === 0) throw new ConversionError('OUT_OF_MEMORY', "Your browser couldn't allocate memory to draw this page. Try a smaller PDF.");
  // PDF pages are paper: white unless they paint their own background.
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: g, viewport }).promise;
  return { canvas, release: () => { canvas.width = canvas.height = 0; } };
}

async function pageFragments(page: PdfPage): Promise<Fragment[]> {
  const content = await page.getTextContent();
  const out: Fragment[] = [];
  for (const item of content.items) {
    if (!('str' in item)) continue;
    const [a, b, , d, e, f] = item.transform as number[];
    // Skip rotated text (vertical labels on charts); it would scramble lines.
    if (Math.abs(b!) > Math.abs(a!) * 0.2) continue;
    out.push({ str: item.str, x: e!, y: f!, width: item.width, size: Math.abs(d!) || item.height, eol: item.hasEOL });
  }
  return out;
}

/** Text of the whole document as paragraphs per page. */
async function extractText(pdf: PdfDocument, ctx: ConversionContext, from: number, to: number): Promise<Paragraph[][]> {
  const pages: Paragraph[][] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    throwIfAborted(ctx.signal);
    const page = await pdf.getPage(n);
    pages.push(toParagraphs(toLines(await pageFragments(page))));
    page.cleanup();
    ctx.onProgress({ fraction: from + ((to - from) * n) / pdf.numPages, stage: `Reading page ${n} of ${pdf.numPages}` });
  }
  return pages;
}

function noText(): ConversionError {
  return new ConversionError(
    'DECODE_FAILED',
    "This PDF has no selectable text, so it's probably a scan or a picture of text. Reading text from images (OCR) isn't available yet. Convert it to PNG or JPEG images instead.",
  );
}

export interface PdfConverterOptions {
  /** False in the standalone file opened from disk, where pdf.js can't load. */
  available: boolean;
}

export function createPdfConverter(opts: PdfConverterOptions): Converter {
  return {
    id: 'pdf',
    category: 'document',

    outputsFor(fromId) {
      return fromId === 'pdf' && opts.available ? [...PDF_OUTPUTS] : [];
    },

    outputLabel(fromId, toId) {
      return fromId === 'pdf' ? LABELS[toId] : undefined;
    },

    unavailableReason(fromId) {
      if (fromId === 'pdf' && !opts.available) {
        return 'PDF files can only be converted on the OpenConverter website or with "npm start", not in the single file opened from disk.';
      }
      return undefined;
    },

    async convert(input: ConversionInput, toId: string, options, ctx: ConversionContext): Promise<ConversionResult> {
      const warnings: string[] = [];
      const title = stripExtension(input.name);
      ctx.onProgress({ fraction: 0.02, stage: 'Opening PDF' });
      const data = await input.file.arrayBuffer();
      // pdf.js takes ownership of the buffer it's given, so keep a copy for pdf-lib.
      const pdf = await openPdf(toId === 'pdf' ? data.slice(0) : data);
      try {
        throwIfAborted(ctx.signal);
        const pages = pdf.numPages;

        // ---- Images: one per page ------------------------------------------
        if (toId === 'png' || toId === 'jpeg') {
          if (pages > MAX_IMAGE_PAGES) {
            throw new ConversionError('IMAGE_TOO_LARGE', `This PDF has ${pages} pages. Up to ${MAX_IMAGE_PAGES} pages can be turned into images at once. Split the PDF first.`);
          }
          const fmt = getFormat(toId);
          const ext = fmt.extensions[0]!;
          const files: { name: string; data: Blob }[] = [];
          let first: { width: number; height: number } | null = null;
          let reduced = false;
          const pad = String(pages).length;
          for (let n = 1; n <= pages; n++) {
            throwIfAborted(ctx.signal);
            ctx.onProgress({ fraction: 0.05 + (0.85 * (n - 1)) / pages, stage: `Rendering page ${n} of ${pages}` });
            const page = await pdf.getPage(n);
            const base = page.getViewport({ scale: 1 });
            if (renderScale(base.width, base.height) < RENDER_DPI / 72 - 1e-9) reduced = true;
            const { canvas, release } = await renderPage(page);
            try {
              first ??= { width: canvas.width, height: canvas.height };
              const name = pages === 1 ? outputFileName(input.name, ext) : `${title}-page-${String(n).padStart(pad, '0')}.${ext}`;
              const blob = await verifyOutput(await canvasToBlob(canvas, fmt.mime, toId === 'jpeg' ? Math.max(0.5, options.quality) : undefined), fmt, name);
              files.push({ name, data: blob });
            } finally {
              release();
              page.cleanup();
            }
          }
          if (reduced) warnings.push(`Some pages are very large, so they were drawn at less than ${RENDER_DPI} dpi to stay within this device's memory limits.`);
          ctx.onProgress({ fraction: 0.95, stage: 'Packing' });
          if (files.length === 1) {
            return { blob: files[0]!.data, format: fmt, fileName: files[0]!.name, width: first?.width, height: first?.height, warnings };
          }
          const zipFmt = getFormat('zip');
          const fileName = outputFileName(input.name, 'zip');
          const zip = await verifyDocument(await createZip(files), zipFmt, fileName);
          warnings.unshift(`${plural(pages, 'page')} saved as ${fmt.label} images (${RENDER_DPI} dpi) in one ZIP file.`);
          return { blob: zip, format: zipFmt, fileName, warnings, label: `${fmt.label} images (ZIP)` };
        }

        // ---- Smaller PDF ---------------------------------------------------
        if (toId === 'pdf') return await compressPdf(pdf, data, input.name, ctx);

        // ---- Text, Markdown, Word ------------------------------------------
        const text = await extractText(pdf, ctx, 0.05, 0.75);
        const all = text.flat();
        if (!all.some((p) => p.text.trim())) throw noText();
        const body = bodySize(all);
        const emptyPages = text.filter((p) => !p.length).length;
        if (emptyPages) warnings.push(`${plural(emptyPages, 'page')} had no selectable text (probably scanned) and ${emptyPages === 1 ? 'was' : 'were'} left out.`);
        ctx.onProgress({ fraction: 0.8, stage: 'Writing' });

        const target = getFormat(toId);
        const fileName = outputFileName(input.name, target.extensions[0]!);
        let out: string | Uint8Array;
        if (toId === 'txt') {
          out = text.map((page) => page.map((p) => p.text).join('\n\n')).filter(Boolean).join('\n\n') + '\n';
        } else if (toId === 'md') {
          out =
            text
              .map((page) => page.map((p) => { const h = headingLevel(p, body); return h ? `${'#'.repeat(h)} ${p.text}` : escapeMd(p.text); }).join('\n\n'))
              .filter(Boolean)
              .join('\n\n') + '\n';
        } else if (toId === 'docx') {
          const blocks: Block[] = [];
          text.forEach((page, i) => {
            if (i > 0 && page.length) blocks.push({ kind: 'pagebreak' });
            for (const p of page) {
              const h = headingLevel(p, body);
              blocks.push(h ? { kind: 'heading', level: h, runs: [{ text: p.text }] } : { kind: 'para', runs: [{ text: p.text }] });
            }
          });
          out = await blocksToDocx(blocks, title);
          warnings.push("Word output keeps the text, paragraphs and headings. Layout, fonts, images and tables aren't kept.");
        } else {
          throw new ConversionError('NO_CONVERTER', `Converting PDF to ${target.label} isn't available.`);
        }
        throwIfAborted(ctx.signal);
        ctx.onProgress({ fraction: 0.95, stage: 'Checking' });
        const blob = await verifyDocument(new Blob([out as BlobPart], { type: target.mime }), target, fileName);
        return { blob, format: target, fileName, warnings };
      } finally {
        // Ends the document and its worker, freeing parsed fonts and images.
        void pdf.loadingTask.destroy();
      }
    },
  };
}

/** Plain text as Markdown that renders the same (no accidental headings, lists or emphasis). */
function escapeMd(s: string): string {
  return s.replace(/([\\`*_[\]<>])/g, '\\$1').replace(/^(\s*)([#>+-])(?=\s)/, '$1\\$2').replace(/^(\s*\d+)\.(?=\s)/, '$1\\.');
}

/**
 * Make a PDF smaller without losing what matters:
 * 1. Rebuild it with compressed object streams, dropping unused and outdated
 *    objects (lossless).
 * 2. If some pages are scans (images with no text), also try re-compressing
 *    just those pages as JPEG at 150 dpi. Pages with text are never turned
 *    into pictures.
 * The smallest result wins; if nothing is smaller, the original is kept.
 */
async function compressPdf(pdf: PdfDocument, data: ArrayBuffer, name: string, ctx: ConversionContext): Promise<ConversionResult> {
  const { PDFDocument, OPS } = await Promise.all([loadPdfLib(), pdfjsLib()]).then(([l, p]) => ({ ...l, OPS: p.OPS }));
  const warnings: string[] = [];
  let src: Awaited<ReturnType<typeof PDFDocument.load>>;
  try {
    src = await PDFDocument.load(data, { updateMetadata: false });
  } catch (e) {
    if ((e as Error)?.name === 'EncryptedPDFError' || /encrypt/i.test(String((e as Error)?.message))) {
      throw new ConversionError('DECODE_FAILED', "This PDF is encrypted, so it can't be compressed. Remove the protection in a PDF app, then try again.", { cause: e });
    }
    throw new ConversionError('DECODE_FAILED', "This PDF couldn't be rebuilt. It may be damaged.", { cause: e });
  }
  ctx.onProgress({ fraction: 0.15, stage: 'Compressing' });
  const candidates: { bytes: Uint8Array; scans: number }[] = [];
  candidates.push({ bytes: await src.save({ useObjectStreams: true }), scans: 0 });

  // Find scanned pages: they draw images and have no text.
  const scans: number[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    throwIfAborted(ctx.signal);
    const page = await pdf.getPage(n);
    const text = await page.getTextContent();
    const hasText = text.items.some((i) => 'str' in i && i.str.trim() !== '');
    if (!hasText) {
      const ops = await page.getOperatorList();
      if (ops.fnArray.some((fn) => fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject)) scans.push(n);
    }
    page.cleanup();
    ctx.onProgress({ fraction: 0.15 + (0.25 * n) / pdf.numPages, stage: `Checking page ${n} of ${pdf.numPages}` });
  }

  if (scans.length) {
    const out = await PDFDocument.create();
    out.setProducer('OpenConverter');
    const scanSet = new Set(scans);
    // Copy only the pages that are kept as they are: pdf-lib saves every
    // object it holds, so copying a scan and then replacing it would keep
    // the original image in the file.
    const keep = src.getPageIndices().filter((i) => !scanSet.has(i + 1));
    const copied = new Map((await out.copyPages(src, keep)).map((p, k) => [keep[k]! + 1, p]));
    for (let n = 1; n <= pdf.numPages; n++) {
      throwIfAborted(ctx.signal);
      if (!scanSet.has(n)) {
        out.addPage(copied.get(n)!);
        continue;
      }
      ctx.onProgress({ fraction: 0.4 + (0.5 * n) / pdf.numPages, stage: `Re-compressing page ${n} of ${pdf.numPages}` });
      const page = await pdf.getPage(n);
      const size = page.getViewport({ scale: 1 });
      const { canvas, release } = await renderPage(page);
      try {
        const jpeg = await canvasToBlob(canvas, 'image/jpeg', 0.72);
        if (!jpeg) throw new ConversionError('ENCODE_FAILED', "A scanned page couldn't be re-compressed.");
        const img = await out.embedJpg(new Uint8Array(await jpeg.arrayBuffer()));
        const p = out.addPage([size.width, size.height]);
        p.drawImage(img, { x: 0, y: 0, width: size.width, height: size.height });
      } finally {
        release();
        page.cleanup();
      }
    }
    candidates.push({ bytes: await out.save({ useObjectStreams: true }), scans: scans.length });
  }

  ctx.onProgress({ fraction: 0.95, stage: 'Checking' });
  const best = candidates.reduce((a, b) => (b.bytes.length < a.bytes.length ? b : a));
  const fmt = getFormat('pdf');
  const fileName = outputFileName(name, 'pdf');
  if (best.bytes.length >= data.byteLength * 0.98) {
    warnings.push("This PDF is already compact. OpenConverter couldn't make it noticeably smaller without lowering its quality, so the result is a copy of the original.");
    const blob = await verifyDocument(new Blob([data], { type: fmt.mime }), fmt, fileName);
    return { blob, format: fmt, fileName, warnings };
  }
  if (best.scans) {
    warnings.push(
      `${plural(best.scans, 'scanned page')} ${best.scans === 1 ? 'was' : 'were'} re-compressed as JPEG at ${RENDER_DPI} dpi. Pages with text were kept as they are. Bookmarks and form fields aren't kept.`,
    );
  }
  const blob = await verifyDocument(new Blob([best.bytes as BlobPart], { type: fmt.mime }), fmt, fileName);
  return { blob, format: fmt, fileName, warnings };
}
