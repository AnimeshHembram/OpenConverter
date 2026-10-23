import { describe, expect, it } from 'vitest';
import { decodeBmp, encodeBmp, hasTransparency, BmpUnsupportedError } from '../../src/modules/image/bmp';

function gradient(w: number, h: number, alpha: (x: number, y: number) => number) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data.set([(x * 37) & 255, (y * 59) & 255, (x * y) & 255, alpha(x, y)], i);
    }
  return { width: w, height: h, data };
}

describe('BMP encoder/decoder', () => {
  it('round-trips 24-bit images exactly (odd width exercises row padding)', () => {
    const img = gradient(13, 7, () => 255);
    const bmp = encodeBmp(img, { alpha: false });
    const rowSize = Math.ceil((13 * 3) / 4) * 4;
    expect(bmp.length).toBe(54 + rowSize * 7);
    expect(new DataView(bmp.buffer).getUint16(28, true)).toBe(24);
    const back = decodeBmp(bmp);
    expect(back.width).toBe(13);
    expect(back.height).toBe(7);
    expect([...back.data]).toEqual([...img.data]);
  });

  it('round-trips 32-bit images with alpha exactly', () => {
    const img = gradient(10, 9, (x, y) => (x + y) * 12);
    const bmp = encodeBmp(img, { alpha: true });
    const v = new DataView(bmp.buffer);
    expect(v.getUint32(14, true)).toBe(108); // BITMAPV4HEADER
    expect(v.getUint16(28, true)).toBe(32);
    expect(v.getUint32(30, true)).toBe(3); // BI_BITFIELDS
    expect(v.getUint32(66, true)).toBe(0xff000000); // alpha mask
    const back = decodeBmp(bmp);
    expect([...back.data]).toEqual([...img.data]);
    expect(hasTransparency(back.data)).toBe(true);
  });

  it('writes the file size field correctly', () => {
    const bmp = encodeBmp(gradient(3, 3, () => 255), { alpha: false });
    expect(new DataView(bmp.buffer).getUint32(2, true)).toBe(bmp.length);
  });

  it('decodes top-down BMPs', () => {
    const img = gradient(4, 3, () => 255);
    const bmp = encodeBmp(img, { alpha: false });
    // Flip the stored rows and mark the image as top-down.
    const rowSize = 12;
    const flipped = bmp.slice();
    for (let y = 0; y < 3; y++) flipped.set(bmp.subarray(54 + y * rowSize, 54 + (y + 1) * rowSize), 54 + (2 - y) * rowSize);
    new DataView(flipped.buffer).setInt32(22, -3, true);
    expect([...decodeBmp(flipped).data]).toEqual([...img.data]);
  });

  it('decodes 8-bit palettised BMPs', () => {
    // 2x2, palette: 0 = red, 1 = blue
    const w = 2, h = 2, rowSize = 4;
    const paletteSize = 2 * 4;
    const offset = 54 + paletteSize;
    const b = new Uint8Array(offset + rowSize * h);
    const v = new DataView(b.buffer);
    b[0] = 0x42; b[1] = 0x4d;
    v.setUint32(2, b.length, true);
    v.setUint32(10, offset, true);
    v.setUint32(14, 40, true);
    v.setInt32(18, w, true);
    v.setInt32(22, h, true);
    v.setUint16(26, 1, true);
    v.setUint16(28, 8, true);
    v.setUint32(46, 2, true); // colours used
    b.set([0, 0, 255, 0, 255, 0, 0, 0], 54); // BGRA0: red, blue
    b.set([1, 0, 0, 0], offset); // bottom row: blue, red
    b.set([0, 1, 0, 0], offset + rowSize); // top row: red, blue
    const img = decodeBmp(b);
    expect([...img.data]).toEqual([255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255, 255, 0, 0, 255]);
  });

  it('treats 32-bit files whose alpha bytes are all zero as opaque', () => {
    const bmp = encodeBmp(gradient(2, 2, () => 0), { alpha: true });
    expect(hasTransparency(decodeBmp(bmp).data)).toBe(false);
  });

  it('defers RLE-compressed files to the browser', () => {
    const bmp = encodeBmp(gradient(2, 2, () => 255), { alpha: false });
    new DataView(bmp.buffer).setUint16(28, 8, true);
    new DataView(bmp.buffer).setUint32(30, 1, true); // BI_RLE8
    expect(() => decodeBmp(bmp)).toThrow(BmpUnsupportedError);
  });

  it('rejects truncated files', () => {
    const bmp = encodeBmp(gradient(20, 20, () => 255), { alpha: false });
    expect(() => decodeBmp(bmp.subarray(0, 200))).toThrow(/truncated/);
  });
});
