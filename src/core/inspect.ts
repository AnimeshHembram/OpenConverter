import { detectAnimation, orientedDimensions, readDimensions, readJpegOrientation, sniff, type Dimensions } from './detect';
import { ConversionError } from './errors';
import { extensionOf, findFormatByExtension, findFormatById } from './formats';
import { MAX_DIMENSION, MAX_FILE_BYTES, MAX_SPREADSHEET_BYTES, MAX_TEXT_BYTES, formatBytes, formatMegapixels, pixelPolicy, type PixelPolicy } from './limits';
import type { FormatInfo } from './types';
import { parseCsv } from './csv';
import { classifyText, decodeText, detectDelimiter, jsonProblem, looksLikeText } from './text';
import { officeKind, zipEntryNames } from './zipdir';

export interface InspectedFile {
  format: FormatInfo;
  /** Short description for documents, e.g. "120 rows × 5 columns". */
  details?: string;
  /** As displayed and converted, i.e. after EXIF orientation. */
  dimensions: Dimensions | null;
  /** EXIF orientation for JPEG (1–8), else null. */
  orientation: number | null;
  /** True/false when known from the header, null when it couldn't be determined. */
  animated: boolean | null;
  warnings: string[];
}

// JPEG headers can sit behind large EXIF/ICC blocks, so read generously.
const HEADER_BYTES = 512 * 1024;

/**
 * Validate a user-supplied file and identify its real format from its bytes.
 * Throws ConversionError with a user-facing message when the file is rejected.
 */
export async function inspectFile(file: File): Promise<InspectedFile> {
  if (file.size === 0) throw new ConversionError('EMPTY_FILE', 'This file is empty.');
  if (file.size > MAX_FILE_BYTES) {
    throw new ConversionError(
      'FILE_TOO_LARGE',
      `This file is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_FILE_BYTES)} per file.`,
    );
  }

  const head = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer());
  const sniffed = sniff(head);
  if (sniffed.container === 'zip') return inspectZip(file, head);
  if (sniffed.container === 'ole') throw legacyOffice(file.name);
  if (!sniffed.formatId) {
    if (sniffed.knownUnsupported) throw new ConversionError('UNSUPPORTED_FORMAT', `${sniffed.knownUnsupported} files aren't supported yet.`);
    const named = findFormatByExtension(file.name);
    if (named?.category === 'image') {
      // A text file wearing an image extension is a broken image, not a document.
      throw new ConversionError('UNSUPPORTED_FORMAT', `This doesn't look like a ${named.label} image. The file may be damaged or not an image at all.`);
    }
    if (looksLikeText(head)) return inspectText(file);
    throw new ConversionError(
      'UNSUPPORTED_FORMAT',
      "This doesn't look like a file OpenConverter can read: an image (PNG, JPEG, WebP, BMP), text, Markdown, JSON, CSV or Excel file.",
    );
  }
  const format = findFormatById(sniffed.formatId)!;
  if (format.input === false) throw new ConversionError('UNSUPPORTED_FORMAT', format.inputMessage ?? `${format.label} files can't be converted yet.`);

  const warnings: string[] = [];
  const byExt = findFormatByExtension(file.name);
  if (extensionOf(file.name) && byExt?.id !== format.id) {
    warnings.push(`The file is named .${extensionOf(file.name)} but is actually a ${format.label} image.`);
  }

  const orientation = format.id === 'jpeg' ? readJpegOrientation(head) : null;
  const stored = readDimensions(format.id, head);
  const dimensions = stored ? orientedDimensions(stored, orientation) : null;
  if (dimensions) checkDimensions(dimensions);

  const animated = detectAnimation(format.id, head);
  if (animated) {
    const kind = format.id === 'png' ? 'an animated PNG (APNG)' : 'an animated WebP';
    warnings.push(`This is ${kind}. Only the first frame will be converted; the animation won't be kept.`);
  }
  return { format, dimensions, orientation, animated, warnings };
}

export function checkDimensions({ width, height }: Dimensions, policy: PixelPolicy = pixelPolicy()): void {
  if (!(width > 0 && height > 0)) {
    throw new ConversionError('DECODE_FAILED', 'This image reports invalid dimensions and may be damaged.');
  }
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new ConversionError(
      'IMAGE_TOO_LARGE',
      `This image is ${width} × ${height}. OpenConverter can handle up to ${MAX_DIMENSION.toLocaleString('en')} pixels per side. Resize it first, then try again.`,
    );
  }
  if (width * height > policy.maxPixels) {
    throw new ConversionError(
      'IMAGE_TOO_LARGE',
      `This image is ${width} × ${height} (${formatMegapixels(width * height)}). On this device the limit is ` +
        `${formatMegapixels(policy.maxPixels)}, because ${policy.reason}. Resize it first, or try on a computer.`,
    );
  }
}

const plural = (n: number, word: string) => `${n.toLocaleString('en')} ${word}${n === 1 ? '' : 's'}`;

/** Text, Markdown, JSON or CSV: decoded and classified by content. */
async function inspectText(file: File): Promise<InspectedFile> {
  if (file.size > MAX_TEXT_BYTES) {
    throw new ConversionError(
      'FILE_TOO_LARGE',
      `This file is ${formatBytes(file.size)}. Text and data files can be up to ${formatBytes(MAX_TEXT_BYTES)}.`,
    );
  }
  const { text, encoding } = decodeText(new Uint8Array(await file.arrayBuffer()));
  const ext = extensionOf(file.name);
  const kind = classifyText(text, ext);
  const format = findFormatById(kind)!;
  const warnings: string[] = [];
  if (kind === 'json') {
    const problem = jsonProblem(text);
    if (problem) throw new ConversionError('DECODE_FAILED', `This file isn't valid JSON, so it can't be converted. ${problem}`);
  }
  if (encoding === 'windows-1252') {
    warnings.push("This file isn't UTF-8, so it was read as Windows-1252 (Western European). If characters look wrong, save it as UTF-8 and try again.");
  }
  const byExt = findFormatByExtension(file.name);
  if (ext && byExt && byExt.id !== kind) {
    warnings.push(
      byExt.id === 'txt'
        ? `This .${ext} file contains ${format.label}, so it's treated as ${format.label}.`
        : `The file is named .${ext} but contains ${format.label}.`,
    );
  }

  let details: string;
  if (kind === 'json') {
    const value: unknown = JSON.parse(text);
    details = Array.isArray(value)
      ? plural(value.length, 'item')
      : value && typeof value === 'object'
        ? plural(Object.keys(value).length, 'key')
        : 'single value';
  } else if (kind === 'csv') {
    const rows = parseCsv(text, detectDelimiter(text, 1) ?? ',');
    const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
    details = `${plural(rows.length, 'row')} × ${plural(cols, 'column')}`;
  } else {
    const lines = text === '' ? 0 : text.split(/\r\n|\n|\r/).length;
    const words = (text.match(/\S+/g) ?? []).length;
    details = `${plural(lines, 'line')} · ${plural(words, 'word')}`;
  }
  return { format, details, dimensions: null, orientation: null, animated: null, warnings };
}

/** Office Open XML and OpenDocument files are ZIP archives. */
async function inspectZip(file: File, head: Uint8Array): Promise<InspectedFile> {
  const names = await zipEntryNames(file);
  // OpenDocument stores its type, uncompressed, as the first entry "mimetype".
  const ascii = (a: number, b: number) => String.fromCharCode(...head.subarray(a, b));
  const extra = head.length > 30 ? head[28]! | (head[29]! << 8) : 0;
  const odf = ascii(30, 38) === 'mimetype' ? ascii(38 + extra, Math.min(head.length, 38 + extra + 80)) : undefined;
  const kind = names ? officeKind(names, odf) : null;
  if (kind === 'xlsx') {
    if (file.size > MAX_SPREADSHEET_BYTES) {
      throw new ConversionError(
        'FILE_TOO_LARGE',
        `This workbook is ${formatBytes(file.size)}. Spreadsheets can be up to ${formatBytes(MAX_SPREADSHEET_BYTES)}, because every cell takes memory once loaded.`,
      );
    }
    const warnings: string[] = [];
    const ext = extensionOf(file.name);
    if (ext && ext !== 'xlsx') warnings.push(`The file is named .${ext} but is actually an Excel workbook.`);
    return { format: findFormatById('xlsx')!, details: 'Excel workbook', dimensions: null, orientation: null, animated: null, warnings };
  }
  if (kind === 'docx' || kind === 'pptx') {
    const f = findFormatById(kind)!;
    throw new ConversionError('UNSUPPORTED_FORMAT', f.inputMessage ?? `${f.label} files can't be converted yet.`);
  }
  const odfAdvice: Record<string, string> = {
    ods: 'OpenDocument spreadsheets (.ods) can\'t be converted yet. Open it in LibreOffice or Google Sheets and save or download it as .xlsx, then add it again.',
    odt: 'OpenDocument text files (.odt) can\'t be converted yet.',
    odp: 'OpenDocument presentations (.odp) can\'t be converted yet.',
  };
  if (kind) throw new ConversionError('UNSUPPORTED_FORMAT', odfAdvice[kind]!);
  throw new ConversionError('UNSUPPORTED_FORMAT', "ZIP archives aren't supported. Extract the files and add them one by one.");
}

/** Office 97–2003 files (.doc, .xls, .ppt) share one binary container. */
function legacyOffice(fileName: string): ConversionError {
  const ext = extensionOf(fileName);
  const kinds: Record<string, { what: string; apps: string; save: string }> = {
    doc: { what: 'Word document', apps: 'Word, Google Docs or LibreOffice', save: '.docx' },
    xls: { what: 'Excel workbook', apps: 'Excel, Google Sheets or LibreOffice', save: '.xlsx' },
    ppt: { what: 'PowerPoint presentation', apps: 'PowerPoint, Google Slides or LibreOffice', save: '.pptx' },
  };
  const k = kinds[ext];
  return new ConversionError(
    'UNSUPPORTED_FORMAT',
    k
      ? `This is an old-style ${k.what} (.${ext}, Office 97–2003), which can't be read in the browser. Open it in ${k.apps}, save it as ${k.save}, then add it again.`
      : "This is an old-style Microsoft Office file (Office 97–2003), which can't be read in the browser. Open it in its Office app and save it in the current format (.docx, .xlsx or .pptx).",
  );
}
