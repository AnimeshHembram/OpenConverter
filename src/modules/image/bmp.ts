/**
 * BMP encoder and decoder in plain TypeScript.
 *
 * Browsers decode BMP but no browser can *encode* it via canvas, so the
 * encoder is always ours. The decoder is used first for BMP input because it
 * treats alpha consistently across browsers; unusual variants it does not
 * handle (RLE compression, embedded PNG/JPEG) fall back to the browser.
 */

export interface RawImage {
  width: number;
  height: number;
  /** Unpremultiplied RGBA, row-major, top-down. */
  data: Uint8ClampedArray;
}

export function hasTransparency(data: Uint8ClampedArray): boolean {
  for (let i = 3; i < data.length; i += 4) if (data[i]! < 255) return true;
  return false;
}

const PPM_72_DPI = 2835;

/**
 * Encode RGBA pixels as BMP. With `alpha: true` writes a 32-bit
 * BITMAPV4HEADER file with an alpha channel; otherwise 24-bit and the alpha
 * channel is ignored (callers flatten transparency first).
 */
export function encodeBmp(img: RawImage, { alpha }: { alpha: boolean }): Uint8Array {
  const { width, height, data } = img;
  const bpp = alpha ? 4 : 3;
  const rowSize = Math.ceil((width * bpp) / 4) * 4;
  const pixelBytes = rowSize * height;
  const dibSize = alpha ? 108 : 40;
  const offset = 14 + dibSize;
  const fileSize = offset + pixelBytes;
  if (fileSize > 0xffff_ffff) throw new RangeError('Image too large for BMP.');

  const out = new Uint8Array(fileSize);
  const v = new DataView(out.buffer);
  // BITMAPFILEHEADER
  out[0] = 0x42;
  out[1] = 0x4d;
  v.setUint32(2, fileSize, true);
  v.setUint32(10, offset, true);
  // DIB header
  v.setUint32(14, dibSize, true);
  v.setInt32(18, width, true);
  v.setInt32(22, height, true); // positive = bottom-up (most compatible)
  v.setUint16(26, 1, true); // planes
  v.setUint16(28, bpp * 8, true);
  v.setUint32(30, alpha ? 3 : 0, true); // BI_BITFIELDS : BI_RGB
  v.setUint32(34, pixelBytes, true);
  v.setInt32(38, PPM_72_DPI, true);
  v.setInt32(42, PPM_72_DPI, true);
  if (alpha) {
    v.setUint32(54, 0x00ff0000, true); // R mask
    v.setUint32(58, 0x0000ff00, true); // G mask
    v.setUint32(62, 0x000000ff, true); // B mask
    v.setUint32(66, 0xff000000, true); // A mask
    v.setUint32(70, 0x73524742, true); // 'sRGB' colour space
  }

  for (let y = 0; y < height; y++) {
    let src = (height - 1 - y) * width * 4;
    let dst = offset + y * rowSize;
    for (let x = 0; x < width; x++, src += 4) {
      out[dst++] = data[src + 2]!; // B
      out[dst++] = data[src + 1]!; // G
      out[dst++] = data[src]!; // R
      if (alpha) out[dst++] = data[src + 3]!;
    }
  }
  return out;
}

export class BmpUnsupportedError extends Error {}

function maskShift(mask: number): { shift: number; max: number } {
  if (mask === 0) return { shift: 0, max: 0 };
  let shift = 0;
  while (((mask >>> shift) & 1) === 0) shift++;
  let bits = 0;
  while (((mask >>> (shift + bits)) & 1) === 1) bits++;
  return { shift, max: (1 << bits) - 1 };
}

/** Decode uncompressed / bitfield BMPs (1, 4, 8, 16, 24, 32 bpp). */
export function decodeBmp(bytes: Uint8Array): RawImage {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 26 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) throw new Error('Not a BMP file.');
  const pixelOffset = v.getUint32(10, true);
  const dibSize = v.getUint32(14, true);

  let width: number;
  let rawHeight: number;
  let bpp: number;
  let compression = 0;
  let colorsUsed = 0;
  let paletteEntrySize = 4;
  if (dibSize === 12) {
    width = v.getUint16(18, true);
    rawHeight = v.getInt16(20, true);
    bpp = v.getUint16(24, true);
    paletteEntrySize = 3;
  } else {
    width = v.getInt32(18, true);
    rawHeight = v.getInt32(22, true);
    bpp = v.getUint16(28, true);
    compression = v.getUint32(30, true);
    colorsUsed = v.getUint32(46, true);
  }
  const topDown = rawHeight < 0;
  const height = Math.abs(rawHeight);
  if (width <= 0 || height <= 0) throw new Error('Invalid BMP dimensions.');

  // BI_RGB=0, BI_BITFIELDS=3, BI_ALPHABITFIELDS=6. RLE / JPEG / PNG -> browser.
  if (![0, 3, 6].includes(compression)) throw new BmpUnsupportedError(`BMP compression ${compression}`);
  if (![1, 4, 8, 16, 24, 32].includes(bpp)) throw new BmpUnsupportedError(`BMP ${bpp} bpp`);

  // Channel masks.
  let rMask = 0, gMask = 0, bMask = 0, aMask = 0;
  if (compression === 3 || compression === 6) {
    // Masks live inside V4/V5 headers, or right after a 40-byte header.
    rMask = v.getUint32(54, true);
    gMask = v.getUint32(58, true);
    bMask = v.getUint32(62, true);
    if (dibSize >= 56 || compression === 6) aMask = v.getUint32(66, true);
  } else if (bpp === 16) {
    rMask = 0x7c00; gMask = 0x03e0; bMask = 0x001f;
  } else if (bpp === 32) {
    rMask = 0x00ff0000; gMask = 0x0000ff00; bMask = 0x000000ff;
    aMask = dibSize >= 56 ? v.getUint32(66, true) : 0;
  }

  // Palette.
  let palette: Uint8Array | null = null;
  if (bpp <= 8) {
    const count = colorsUsed || 1 << bpp;
    const start = 14 + dibSize + (compression === 3 && dibSize === 40 ? 12 : 0);
    palette = new Uint8Array(count * 4);
    for (let i = 0; i < count; i++) {
      const p = start + i * paletteEntrySize;
      if (p + 2 >= bytes.length) break;
      palette[i * 4] = bytes[p + 2]!;
      palette[i * 4 + 1] = bytes[p + 1]!;
      palette[i * 4 + 2] = bytes[p]!;
      palette[i * 4 + 3] = 255;
    }
  }

  const rowSize = Math.ceil((width * bpp) / 32) * 4;
  if (pixelOffset + rowSize * height > bytes.length) throw new Error('BMP file is truncated.');

  const out = new Uint8ClampedArray(width * height * 4);
  const r = maskShift(rMask), g = maskShift(gMask), b = maskShift(bMask), a = maskShift(aMask);
  const scale = (val: number, m: { shift: number; max: number }) =>
    m.max === 0 ? 0 : m.max === 255 ? (val >>> m.shift) & 255 : Math.round((((val >>> m.shift) & m.max) * 255) / m.max);

  let anyAlpha = false;
  for (let y = 0; y < height; y++) {
    const srcRow = pixelOffset + (topDown ? y : height - 1 - y) * rowSize;
    let dst = y * width * 4;
    for (let x = 0; x < width; x++, dst += 4) {
      if (bpp <= 8) {
        const bitPos = x * bpp;
        const byte = bytes[srcRow + (bitPos >> 3)]!;
        const idx = (byte >> (8 - bpp - (bitPos & 7))) & ((1 << bpp) - 1);
        out[dst] = palette![idx * 4]!;
        out[dst + 1] = palette![idx * 4 + 1]!;
        out[dst + 2] = palette![idx * 4 + 2]!;
        out[dst + 3] = 255;
      } else if (bpp === 24) {
        const p = srcRow + x * 3;
        out[dst] = bytes[p + 2]!;
        out[dst + 1] = bytes[p + 1]!;
        out[dst + 2] = bytes[p]!;
        out[dst + 3] = 255;
      } else {
        const p = srcRow + x * (bpp / 8);
        const val = bpp === 16 ? v.getUint16(p, true) : v.getUint32(p, true);
        out[dst] = scale(val, r);
        out[dst + 1] = scale(val, g);
        out[dst + 2] = scale(val, b);
        if (aMask) {
          const av = scale(val, a);
          out[dst + 3] = av;
          if (av !== 0) anyAlpha = true;
        } else {
          out[dst + 3] = 255;
        }
      }
    }
  }
  // Many writers leave the alpha byte as 0 meaning "unused". A fully
  // transparent image is almost always that mistake, so treat it as opaque.
  if (aMask && !anyAlpha) for (let i = 3; i < out.length; i += 4) out[i] = 255;

  return { width, height, data: out };
}
