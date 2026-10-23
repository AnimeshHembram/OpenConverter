import type { FormatInfo } from './types';

/**
 * Every format OpenConvert can read or write. Document formats will be added
 * here in Phase 2 with `category: 'document'`.
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
];

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

/** Value for <input accept>: every extension and MIME type we can read. */
export function acceptAttribute(category: FormatInfo['category']): string {
  const parts: string[] = [];
  for (const f of FORMATS) {
    if (f.category !== category) continue;
    parts.push(f.mime, ...(f.altMimes ?? []), ...f.extensions.map((e) => `.${e}`));
  }
  return parts.join(',');
}
