/**
 * Content-based format detection. File extensions and browser-reported MIME
 * types are hints only; the magic bytes decide what a file really is.
 */

export interface SniffResult {
  /** Supported format id, if the bytes match one. */
  formatId: string | null;
  /** Human name for recognised-but-unsupported formats (for clearer errors). */
  knownUnsupported?: string;
}

const ascii = (b: Uint8Array, start: number, len: number): string =>
  String.fromCharCode(...b.subarray(start, start + len));

export function sniff(bytes: Uint8Array): SniffResult {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a) {
    return { formatId: 'png' };
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return { formatId: 'jpeg' };
  }
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    return { formatId: 'webp' };
  }
  if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) {
    // "BM" alone is weak; check that the DIB header size is a known value.
    const dib = b[14]! | (b[15]! << 8) | (b[16]! << 16) | (b[17]! << 24);
    if ([12, 40, 52, 56, 64, 108, 124].includes(dib)) return { formatId: 'bmp' };
  }

  // Recognised formats we do not (yet) convert, so the error can name them.
  if (b.length >= 6 && ascii(b, 0, 3) === 'GIF') return { formatId: null, knownUnsupported: 'GIF' };
  if (b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 0x2a))) {
    return { formatId: null, knownUnsupported: 'TIFF' };
  }
  if (b.length >= 12 && ascii(b, 4, 4) === 'ftyp') {
    const brand = ascii(b, 8, 4);
    if (brand.startsWith('avi')) return { formatId: null, knownUnsupported: 'AVIF' };
    if (['heic', 'heix', 'hevc', 'mif1', 'msf1', 'heim', 'heis'].includes(brand)) {
      return { formatId: null, knownUnsupported: 'HEIC/HEIF' };
    }
  }
  if (b.length >= 5 && ascii(b, 0, 5) === '%PDF-') return { formatId: null, knownUnsupported: 'PDF' };
  if (b.length >= 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return { formatId: null, knownUnsupported: 'ICO' };
  const head = new TextDecoder().decode(b.subarray(0, Math.min(b.length, 256))).trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
    return { formatId: null, knownUnsupported: 'SVG' };
  }
  return { formatId: null };
}

export interface Dimensions {
  width: number;
  height: number;
}

const u16be = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
const u16le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u24le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
const u32be = (b: Uint8Array, o: number) => ((b[o]! << 24) >>> 0) + ((b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!);
const i32le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24);

/**
 * Read image dimensions from the file header without decoding pixels, so
 * oversized images ("decompression bombs") are rejected before they can
 * exhaust memory. Returns null when the header is not in the given bytes.
 */
export function readDimensions(formatId: string, b: Uint8Array): Dimensions | null {
  try {
    switch (formatId) {
      case 'png':
        if (b.length < 24 || ascii(b, 12, 4) !== 'IHDR') return null;
        return { width: u32be(b, 16), height: u32be(b, 20) };
      case 'bmp': {
        if (b.length < 26) return null;
        const dib = i32le(b, 14);
        if (dib === 12) return { width: u16le(b, 18), height: u16le(b, 20) };
        return { width: Math.abs(i32le(b, 18)), height: Math.abs(i32le(b, 22)) };
      }
      case 'webp': {
        if (b.length < 30) return null;
        const chunk = ascii(b, 12, 4);
        if (chunk === 'VP8 ') {
          return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
        }
        if (chunk === 'VP8L') {
          const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
          return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
        }
        if (chunk === 'VP8X') {
          return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
        }
        return null;
      }
      case 'jpeg': {
        let o = 2;
        while (o + 9 < b.length) {
          if (b[o] !== 0xff) {
            o++;
            continue;
          }
          const marker = b[o + 1]!;
          if (marker === 0xff) {
            o++;
            continue;
          }
          // Standalone markers without a length field.
          if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            o += 2;
            continue;
          }
          const len = u16be(b, o + 2);
          const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
          if (isSOF) return { width: u16be(b, o + 7), height: u16be(b, o + 5) };
          if (marker === 0xda || marker === 0xd9) return null;
          o += 2 + len;
        }
        return null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Whether the image is animated, from its header bytes.
 * - APNG: an `acTL` chunk declaring more than one frame appears before the
 *   first `IDAT` (required by the APNG spec).
 * - WebP: the animation flag in the `VP8X` extended header.
 * Returns null when the answer isn't in the given bytes.
 */
export function detectAnimation(formatId: string, b: Uint8Array): boolean | null {
  try {
    if (formatId === 'png') {
      let o = 8;
      while (o + 8 <= b.length) {
        const len = u32be(b, o);
        const type = ascii(b, o + 4, 4);
        if (type === 'acTL') return o + 12 <= b.length ? u32be(b, o + 8) > 1 : null;
        if (type === 'IDAT' || type === 'IEND') return false;
        o += 12 + len;
      }
      return null;
    }
    if (formatId === 'webp') {
      if (b.length < 21) return null;
      if (ascii(b, 12, 4) !== 'VP8X') return false; // simple formats can't animate
      return (b[20]! & 0x02) !== 0;
    }
    return false; // JPEG and BMP have no animation
  } catch {
    return null;
  }
}

/**
 * EXIF orientation (1–8) of a JPEG, or null if absent. Values 5–8 mean the
 * stored image is rotated by 90° or 270°, so width and height are swapped
 * when displayed.
 */
export function readJpegOrientation(b: Uint8Array): number | null {
  try {
    let o = 2;
    while (o + 4 <= b.length) {
      if (b[o] !== 0xff) return null;
      const marker = b[o + 1]!;
      if (marker === 0xda || marker === 0xd9) return null; // image data starts: no EXIF
      const len = u16be(b, o + 2);
      if (marker === 0xe1 && ascii(b, o + 4, 6) === 'Exif\0\0') {
        const t = o + 10; // TIFF header
        const le = ascii(b, t, 2) === 'II';
        const r16 = (p: number) => (le ? u16le(b, p) : u16be(b, p));
        const r32 = (p: number) => (le ? i32le(b, p) >>> 0 : u32be(b, p));
        if (r16(t + 2) !== 42) return null;
        const ifd = t + r32(t + 4);
        const count = r16(ifd);
        for (let i = 0; i < count; i++) {
          const e = ifd + 2 + i * 12;
          if (e + 12 > b.length) return null;
          if (r16(e) === 0x0112) {
            const v = r16(e + 8);
            return v >= 1 && v <= 8 ? v : null;
          }
        }
        return null;
      }
      o += 2 + len;
    }
    return null;
  } catch {
    return null;
  }
}

/** Dimensions as displayed, after applying EXIF orientation. */
export function orientedDimensions(d: Dimensions, orientation: number | null): Dimensions {
  return orientation !== null && orientation >= 5 ? { width: d.height, height: d.width } : d;
}
