import { describe, expect, it } from 'vitest';
import { detectAnimation, orientedDimensions, readDimensions, readJpegOrientation } from '../../src/core/detect';
import { inspectFile } from '../../src/core/inspect';
import { jpegWithOrientation, pngChunk, pngToApng } from '../fixtures/builders';

const SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdr = (w: number, h: number) => pngChunk('IHDR', [0, 0, w >> 8, w & 255, 0, 0, h >> 8, h & 255, 8, 6, 0, 0, 0]);
const join = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const staticPng = join(SIG, ihdr(4, 3), pngChunk('IDAT', [0x78, 0x9c, 3, 0, 0, 0, 0, 1]), pngChunk('IEND', []));

describe('animation detection', () => {
  it('static PNG is not animated', () => {
    expect(detectAnimation('png', staticPng)).toBe(false);
  });

  it('APNG with 2+ frames is animated; a 1-frame acTL is not', () => {
    expect(detectAnimation('png', pngToApng(staticPng, 2))).toBe(true);
    expect(detectAnimation('png', pngToApng(staticPng, 1))).toBe(false);
  });

  it('returns null when the header is truncated before the answer', () => {
    expect(detectAnimation('png', staticPng.subarray(0, 20))).toBeNull();
  });

  it('WebP: VP8X animation flag', () => {
    const vp8x = (flags: number) => new Uint8Array([...'RIFF'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [...'WEBPVP8X'].map((c) => c.charCodeAt(0)), [10, 0, 0, 0, flags, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    expect(detectAnimation('webp', vp8x(0x02))).toBe(true);
    expect(detectAnimation('webp', vp8x(0x10))).toBe(false); // alpha only
    const simple = new Uint8Array([...'RIFF\0\0\0\0WEBPVP8 '].map((c) => c.charCodeAt(0)).concat(Array(10).fill(0)));
    expect(detectAnimation('webp', simple)).toBe(false);
  });

  it('inspectFile warns before conversion that only the first frame is kept', async () => {
    const info = await inspectFile(new File([pngToApng(staticPng) as Uint8Array<ArrayBuffer>], 'anim.png'));
    expect(info.animated).toBe(true);
    expect(info.warnings).toContain("This is an animated PNG (APNG). Only the first frame will be converted; the animation won't be kept.");
    const plain = await inspectFile(new File([staticPng as Uint8Array<ArrayBuffer>], 'still.png'));
    expect(plain.animated).toBe(false);
    expect(plain.warnings).toEqual([]);
  });
});

describe('EXIF orientation', () => {
  // Minimal JPEG: SOI, SOF0 40x20, EOI.
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 20, 0, 40, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);

  it('reads orientation in little- and big-endian EXIF', () => {
    for (const o of [1, 3, 6, 8]) {
      expect(readJpegOrientation(jpegWithOrientation(jpeg, o, true))).toBe(o);
      expect(readJpegOrientation(jpegWithOrientation(jpeg, o, false))).toBe(o);
    }
  });

  it('returns null without EXIF, with invalid values, or on truncation', () => {
    expect(readJpegOrientation(jpeg)).toBeNull();
    expect(readJpegOrientation(jpegWithOrientation(jpeg, 9))).toBeNull();
    expect(readJpegOrientation(jpegWithOrientation(jpeg, 6).subarray(0, 20))).toBeNull();
  });

  it('swaps displayed width and height for 90°/270° orientations', () => {
    expect(readDimensions('jpeg', jpegWithOrientation(jpeg, 6))).toEqual({ width: 40, height: 20 });
    expect(orientedDimensions({ width: 40, height: 20 }, 6)).toEqual({ width: 20, height: 40 });
    expect(orientedDimensions({ width: 40, height: 20 }, 3)).toEqual({ width: 40, height: 20 });
    expect(orientedDimensions({ width: 40, height: 20 }, null)).toEqual({ width: 40, height: 20 });
  });

  it('inspectFile reports the dimensions as displayed', async () => {
    const info = await inspectFile(new File([jpegWithOrientation(jpeg, 6) as Uint8Array<ArrayBuffer>], 'r.jpg'));
    expect(info.orientation).toBe(6);
    expect(info.dimensions).toEqual({ width: 20, height: 40 });
  });
});
