import { describe, expect, it } from 'vitest';
import { sniff } from '../../src/core/detect';
import { MIN_QUALITY, fitToSize, parseSize } from '../../src/modules/image/compress';
import { jpegToPdf, pageSize, readJpegFrame } from '../../src/modules/image/pdf';

/** A structurally valid JPEG header: SOI, APP0, SOF0 (w×h, n components), SOS, EOI. */
function fakeJpeg(width: number, height: number, components = 3): Uint8Array {
  const sof = [0xff, 0xc0, 0, 8 + components * 3, 8, height >> 8, height & 255, width >> 8, width & 255, components];
  for (let c = 0; c < components; c++) sof.push(c + 1, 0x11, 0);
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
    ...sof,
    0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0,
    0x12, 0x34, 0x56,
    0xff, 0xd9,
  ]);
}

const latin1 = (b: Uint8Array) => new TextDecoder('latin1').decode(b);

describe('readJpegFrame', () => {
  it('reads dimensions and components after other segments', () => {
    expect(readJpegFrame(fakeJpeg(640, 480))).toEqual({ width: 640, height: 480, components: 3 });
    expect(readJpegFrame(fakeJpeg(3, 5, 1))).toEqual({ width: 3, height: 5, components: 1 });
  });
  it('rejects non-JPEG data', () => {
    expect(readJpegFrame(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });
});

describe('jpegToPdf', () => {
  const jpeg = fakeJpeg(800, 600);
  const pdf = jpegToPdf(jpeg);
  const text = latin1(pdf);

  it('starts with a PDF signature that verifyOutput recognises', () => {
    expect(sniff(pdf.subarray(0, 32)).formatId).toBe('pdf');
    expect(text.endsWith('%%EOF\n')).toBe(true);
  });

  it('sizes the page to the image at 96 px per inch', () => {
    expect(pageSize(800, 600)).toEqual({ w: 600, h: 450 });
    expect(text).toContain('/MediaBox [0 0 600 450]');
    expect(text).toContain('q 600 0 0 450 0 0 cm /Im0 Do Q');
  });

  it('embeds the JPEG unchanged with the right colour space', () => {
    expect(text).toContain(`/Width 800 /Height 600 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length}`);
    const start = text.indexOf('stream\n') + 'stream\n'.length;
    expect([...pdf.subarray(start, start + jpeg.length)]).toEqual([...jpeg]);
    expect(latin1(jpegToPdf(fakeJpeg(2, 2, 1)))).toContain('/ColorSpace /DeviceGray');
  });

  it('has a cross-reference table whose offsets point at each object', () => {
    const startxref = Number(/startxref\n(\d+)\n/.exec(text)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');
    const rows = text.slice(startxref).split('\n').slice(3, 9);
    rows.forEach((row, i) => {
      const offset = Number(row.slice(0, 10));
      expect(text.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
    });
  });

  it('refuses data that is not a JPEG', () => {
    expect(() => jpegToPdf(new Uint8Array([1, 2, 3, 4]))).toThrow();
  });
});

describe('fitToSize', () => {
  // A fake encoder whose output size grows with quality: 100 + 1000 * q bytes.
  const encoder = () => {
    const calls: number[] = [];
    const encode = async (q: number) => {
      calls.push(q);
      return new Blob([new Uint8Array(Math.round(100 + 1000 * q))]);
    };
    return { encode, calls };
  };

  it('keeps the chosen quality when it already fits', async () => {
    const { encode, calls } = encoder();
    const r = await fitToSize(encode, 2000, 0.85);
    expect(r).toMatchObject({ quality: 0.85, fits: true });
    expect(calls).toEqual([0.85]);
  });

  it('finds the highest quality under the limit', async () => {
    const { encode } = encoder();
    const r = await fitToSize(encode, 500, 0.9); // fits up to q = 0.4
    expect(r.fits).toBe(true);
    expect(r.blob.size).toBeLessThanOrEqual(500);
    expect(r.quality).toBeGreaterThan(0.35);
    expect(r.quality).toBeLessThanOrEqual(0.4);
  });

  it('returns the smallest result, marked as not fitting, when the limit is impossible', async () => {
    const { encode, calls } = encoder();
    const r = await fitToSize(encode, 50, 0.9);
    expect(r).toMatchObject({ fits: false, quality: MIN_QUALITY });
    expect(calls.length).toBe(2); // the start and the floor, then it stops
  });

  it('stops when cancelled', async () => {
    const { encode } = encoder();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(fitToSize(encode, 500, 0.9, ctrl.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

describe('parseSize', () => {
  it('parses numbers with optional units', () => {
    expect(parseSize('500')).toBe(500 * 1024);
    expect(parseSize('1.5', 'MB')).toBe(1.5 * 1024 * 1024);
    expect(parseSize('2 mb')).toBe(2 * 1024 * 1024);
    expect(parseSize('250,5 KB')).toBe(Math.round(250.5 * 1024));
  });
  it('rejects empty, zero and nonsense', () => {
    expect(parseSize('')).toBeNull();
    expect(parseSize('0')).toBeNull();
    expect(parseSize('-3')).toBeNull();
    expect(parseSize('abc')).toBeNull();
  });
});
