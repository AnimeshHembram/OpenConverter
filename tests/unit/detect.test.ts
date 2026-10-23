import { describe, expect, it } from 'vitest';
import { readDimensions, sniff } from '../../src/core/detect';
import { encodeBmp } from '../../src/modules/image/bmp';

const bytes = (...xs: (number | string)[]) =>
  new Uint8Array(xs.flatMap((x) => (typeof x === 'string' ? [...x].map((c) => c.charCodeAt(0)) : [x])));

function pngHeader(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, w);
  v.setUint32(20, h);
  return b;
}

function jpegHeader(w: number, h: number): Uint8Array {
  // SOI, APP0 (16 bytes), SOF0
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...'JFIF'.split('').map((c) => c.charCodeAt(0)), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof]);
}

describe('sniff', () => {
  it('identifies supported formats from magic bytes', () => {
    expect(sniff(pngHeader(1, 1)).formatId).toBe('png');
    expect(sniff(jpegHeader(1, 1)).formatId).toBe('jpeg');
    expect(sniff(bytes('RIFF', 0, 0, 0, 0, 'WEBPVP8 ')).formatId).toBe('webp');
    const bmp = encodeBmp({ width: 1, height: 1, data: new Uint8ClampedArray(4) }, { alpha: false });
    expect(sniff(bmp).formatId).toBe('bmp');
  });

  it('does not accept a text file that merely starts with "BM"', () => {
    expect(sniff(new TextEncoder().encode('BMW owners club newsletter, issue 4')).formatId).toBeNull();
  });

  it('names recognised but unsupported formats', () => {
    expect(sniff(bytes('GIF89a', 1, 0, 1, 0)).knownUnsupported).toBe('GIF');
    expect(sniff(bytes(0, 0, 0, 0x18, 'ftypheic', 0, 0, 0, 0)).knownUnsupported).toBe('HEIC/HEIF');
    expect(sniff(bytes(0, 0, 0, 0x18, 'ftypavif', 0, 0, 0, 0)).knownUnsupported).toBe('AVIF');
    expect(sniff(bytes('%PDF-1.7')).knownUnsupported).toBe('PDF');
    expect(sniff(new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="x"/>')).knownUnsupported).toBe('SVG');
    expect(sniff(bytes('hello world')).formatId).toBeNull();
  });
});

describe('readDimensions', () => {
  it('reads PNG IHDR', () => {
    expect(readDimensions('png', pngHeader(4000, 3000))).toEqual({ width: 4000, height: 3000 });
  });

  it('reads JPEG SOF after APP segments', () => {
    expect(readDimensions('jpeg', jpegHeader(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  });

  it('reads BMP headers, including top-down (negative height)', () => {
    const b = encodeBmp({ width: 7, height: 5, data: new Uint8ClampedArray(7 * 5 * 4) }, { alpha: true });
    expect(readDimensions('bmp', b)).toEqual({ width: 7, height: 5 });
    new DataView(b.buffer).setInt32(22, -5, true);
    expect(readDimensions('bmp', b)).toEqual({ width: 7, height: 5 });
  });

  it('reads WebP VP8, VP8L and VP8X chunks', () => {
    const vp8 = new Uint8Array(30);
    vp8.set(bytes('RIFF', 0, 0, 0, 0, 'WEBPVP8 '));
    new DataView(vp8.buffer).setUint16(26, 640, true);
    new DataView(vp8.buffer).setUint16(28, 480, true);
    expect(readDimensions('webp', vp8)).toEqual({ width: 640, height: 480 });

    const vp8l = new Uint8Array(30);
    vp8l.set(bytes('RIFF', 0, 0, 0, 0, 'WEBPVP8L'));
    vp8l[20] = 0x2f;
    const bits = (100 - 1) | ((50 - 1) << 14);
    new DataView(vp8l.buffer).setUint32(21, bits, true);
    expect(readDimensions('webp', vp8l)).toEqual({ width: 100, height: 50 });

    const vp8x = new Uint8Array(30);
    vp8x.set(bytes('RIFF', 0, 0, 0, 0, 'WEBPVP8X'));
    vp8x.set([(5000 - 1) & 255, ((5000 - 1) >> 8) & 255, 0], 24);
    vp8x.set([(3000 - 1) & 255, ((3000 - 1) >> 8) & 255, 0], 27);
    expect(readDimensions('webp', vp8x)).toEqual({ width: 5000, height: 3000 });
  });

  it('returns null rather than throwing on truncated headers', () => {
    expect(readDimensions('png', new Uint8Array(10))).toBeNull();
    expect(readDimensions('jpeg', new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
  });
});
