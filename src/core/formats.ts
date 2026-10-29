import type { FormatInfo } from './types';

/**
 * Every format OpenConverter can read or write. Images are read and written;
 * PDF (`category: 'document'`) is currently an output only: images can be
 * saved as PDFs, but PDFs are not accepted as input.
 */
export const FORMATS: readonly FormatInfo[] = [
  {
    id: 'png',
    label: 'PNG',
    mime: 'image/png',
    altMimes: ['image/apng'],
    extensions: ['png', 'apng'],
    category: 'image',
    lossy: false,
    supportsAlpha: true,
  },
  {
    id: 'jpeg',
    label: 'JPEG',
    mime: 'image/jpeg',
    altMimes: ['image/jpg', 'image/pjpeg'],
    extensions: ['jpg', 'jpeg', 'jpe', 'jfif'],
    category: 'image',
    lossy: true,
    supportsAlpha: false,
  },
  {
    id: 'webp',
    label: 'WebP',
    mime: 'image/webp',
    extensions: ['webp'],
    category: 'image',
    lossy: true,
    supportsAlpha: true,
  },
  {
    id: 'bmp',
    label: 'BMP',
    mime: 'image/bmp',
    altMimes: ['image/x-bmp', 'image/x-ms-bmp'],
    extensions: ['bmp', 'dib'],
    category: 'image',
    lossy: false,
    supportsAlpha: true, // via 32-bit BITMAPV4HEADER
  },
  {
    id: 'pdf',
    label: 'PDF',
    mime: 'application/pdf',
    extensions: ['pdf'],
    category: 'document',
    lossy: true, // the page image is stored as JPEG, so quality applies
    supportsAlpha: false,
  },
  // ---- Text and data -------------------------------------------------------
  { id: 'txt', label: 'Text', mime: 'text/plain', extensions: ['txt', 'text', 'log'], category: 'document', lossy: false, supportsAlpha: false },
  {
    id: 'md',
    label: 'Markdown',
    mime: 'text/markdown',
    altMimes: ['text/x-markdown'],
    extensions: ['md', 'markdown'],
    category: 'document',
    lossy: false,
    supportsAlpha: false,
  },
  { id: 'json', label: 'JSON', mime: 'application/json', extensions: ['json'], category: 'document', lossy: false, supportsAlpha: false },
  {
    id: 'csv',
    label: 'CSV',
    mime: 'text/csv',
    altMimes: ['text/tab-separated-values', 'application/vnd.ms-excel'],
    extensions: ['csv', 'tsv'],
    category: 'document',
    lossy: false,
    supportsAlpha: false,
  },
  {
    id: 'html',
    label: 'HTML',
    mime: 'text/html',
    extensions: ['html', 'htm'],
    category: 'document',
    lossy: false,
    supportsAlpha: false,
    input: false,
    inputMessage: "HTML files can't be converted yet.",
  },
  {
    id: 'xlsx',
    label: 'Excel',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extensions: ['xlsx'],
    category: 'document',
    lossy: false,
    supportsAlpha: false,
  },
  // Output only: several files (e.g. the pages of a PDF as images) in one download.
  {
    id: 'zip',
    label: 'ZIP',
    mime: 'application/zip',
    extensions: ['zip'],
    category: 'document',
    lossy: false,
    supportsAlpha: false,
    input: false,
    inputMessage: "ZIP archives aren't supported. Extract the files and add them one by one.",
  },
  // ---- Office documents: Word and PowerPoint are written, not read yet -------
  {
    id: 'docx',
    label: 'Word',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extensions: ['docx'],
    category: 'document',
    lossy: false,
    supportsAlpha: false,
    input: false,
    inputMessage: "Word documents can't be converted yet.",
  },
  {
    id: 'pptx',
    label: 'PowerPoint',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    extensions: ['pptx'],
    category: 'document',
    lossy: false,
    supportsAlpha: false,
    input: false,
    inputMessage: "PowerPoint presentations can't be converted yet.",
  },
];

/** Formats that can be selected as input, i.e. everything the file picker should offer. */
export const INPUT_EXTENSIONS = ['xls', 'ods', 'doc', 'ppt', 'odt', 'odp'];

const byId = new Map(FORMATS.map((f) => [f.id, f]));

export function getFormat(id: string): FormatInfo {
  const f = byId.get(id);
  if (!f) throw new Error(`Unknown format: ${id}`);
  return f;
}

export function findFormatById(id: string): FormatInfo | undefined {
  return byId.get(id);
}

export function findFormatByExtension(fileName: string): FormatInfo | undefined {
  const ext = extensionOf(fileName);
  if (!ext) return undefined;
  return FORMATS.find((f) => f.extensions.includes(ext));
}

export function findFormatByMime(mime: string): FormatInfo | undefined {
  const m = mime.toLowerCase();
  return FORMATS.find((f) => f.mime === m || f.altMimes?.includes(m));
}

export function extensionOf(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/**
 * Value for <input accept>: every format we recognise, including ones that
 * are rejected with advice (so the picker doesn't hide them).
 */
export function acceptAttribute(category?: FormatInfo['category']): string {
  const parts: string[] = [];
  for (const f of FORMATS) {
    if (category && f.category !== category) continue;
    parts.push(f.mime, ...(f.altMimes ?? []), ...f.extensions.map((e) => `.${e}`));
  }
  if (!category) parts.push(...INPUT_EXTENSIONS.map((e) => `.${e}`));
  return [...new Set(parts)].join(',');
}
