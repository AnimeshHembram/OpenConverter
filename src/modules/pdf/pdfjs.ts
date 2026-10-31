/**
 * PDF reading with pdf.js (Mozilla, Apache-2.0), loaded only when a PDF is
 * converted. Parsing runs in a same-origin Web Worker so the page stays
 * responsive; PDF JavaScript is never executed (no scripting sandbox is
 * shipped, and forms/XFA aren't rendered).
 */
import { ConversionError } from '../../core/errors';
import { installStreamIterator } from './stream-iterator';

// The "legacy" build: pdf.js's standard build needs very recent JavaScript
// (e.g. Map.getOrInsertComputed) that many browsers in use don't have yet.
type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
export type PdfDocument = import('pdfjs-dist').PDFDocumentProxy;
export type PdfPage = import('pdfjs-dist').PDFPageProxy;

let lib: Promise<PdfJs> | null = null;

async function load(): Promise<PdfJs> {
  lib ??= (async () => {
    // Before pdf.js runs: Safari 26 and earlier can't iterate ReadableStreams,
    // which pdf.js needs to read page text (see stream-iterator.ts).
    installStreamIterator();
    // Our worker entry wraps pdf.js's worker with the same stream fix.
    const [pdfjs, worker] = await Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'), import('./pdf.worker?worker&url')]);
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  })();
  try {
    return await lib;
  } catch (e) {
    lib = null;
    throw new ConversionError('ENCODER_LOAD_FAILED', "OpenConverter's PDF reader couldn't be loaded. Check your internet connection and try again.", {
      cause: e,
    });
  }
}

/** Where pdf.js finds its data files, served by this site (see vite.config.ts). */
const assetBase = () => new URL(`${import.meta.env.BASE_URL}assets/pdfjs/`, location.href).href;

/** pdf.js itself, e.g. for its operator codes. */
export const pdfjsLib = load;

export async function openPdf(data: ArrayBuffer): Promise<PdfDocument> {
  const pdfjs = await load();
  const base = assetBase();
  const task = pdfjs.getDocument({
    data: new Uint8Array(data),
    cMapUrl: `${base}cmaps/`,
    standardFontDataUrl: `${base}standard_fonts/`,
    iccUrl: `${base}iccs/`,
    wasmUrl: `${base}wasm/`,
    enableXfa: false,
    // Fonts the PDF doesn't embed use the bundled standard fonts, so output
    // doesn't depend on what's installed on this device.
    useSystemFonts: false,
    verbosity: 0,
  });
  try {
    return await task.promise;
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === 'PasswordException') {
      throw new ConversionError('DECODE_FAILED', 'This PDF is password-protected. Remove the password in a PDF app, then add it again.', { cause: e });
    }
    if (name === 'InvalidPDFException') {
      throw new ConversionError('DECODE_FAILED', "This PDF couldn't be read. It may be damaged or incomplete.", { cause: e });
    }
    throw new ConversionError('DECODE_FAILED', "This PDF couldn't be opened. It may be damaged or use features OpenConverter can't read.", { cause: e });
  }
}
