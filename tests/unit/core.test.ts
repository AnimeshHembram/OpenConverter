import { describe, expect, it } from 'vitest';
import { ConversionError } from '../../src/core/errors';
import { dedupeNames, outputFileName, sanitizeBaseName } from '../../src/core/filename';
import { acceptAttribute, findFormatByExtension, findFormatByMime } from '../../src/core/formats';
import { checkDimensions, inspectFile } from '../../src/core/inspect';
import { MAX_FILE_BYTES, formatBytes, isIOS } from '../../src/core/limits';
import { crc32, createZip } from '../../src/core/zip';
import { encodeBmp } from '../../src/modules/image/bmp';

describe('formats', () => {
  it('maps extensions and MIME types', () => {
    expect(findFormatByExtension('Photo.JPG')?.id).toBe('jpeg');
    expect(findFormatByExtension('a.tar.webp')?.id).toBe('webp');
    expect(findFormatByExtension('noext')).toBeUndefined();
    expect(findFormatByMime('image/x-ms-bmp')?.id).toBe('bmp');
    expect(acceptAttribute('image')).toContain('.jpeg');
  });
});

describe('file names', () => {
  it('replaces the extension and keeps the rest', () => {
    expect(outputFileName('holiday photo.PNG', 'jpg')).toBe('holiday photo.jpg');
    expect(outputFileName('archive.v2.final.bmp', 'webp')).toBe('archive.v2.final.webp');
    expect(outputFileName('.hidden', 'png')).toBe('.hidden.png');
  });

  it('removes characters that are illegal on common systems', () => {
    expect(sanitizeBaseName('a<b>:c"d|e?f*')).toBe('a_b__c_d_e_f_');
    expect(sanitizeBaseName('CON')).toBe('CON_');
    expect(sanitizeBaseName('')).toBe('image');
  });

  it('de-duplicates names case-insensitively for ZIPs', () => {
    expect(dedupeNames(['a.jpg', 'A.jpg', 'a.jpg', 'b.jpg'])).toEqual(['a.jpg', 'A (2).jpg', 'a (3).jpg', 'b.jpg']);
    expect(dedupeNames(['x (2).png', 'x.png', 'x.png'])).toEqual(['x (2).png', 'x.png', 'x (3).png']);
  });
});

describe('inspectFile', () => {
  const bmpBytes = encodeBmp({ width: 3, height: 2, data: new Uint8ClampedArray(24) }, { alpha: false });

  it('detects the real format and dimensions, warning on a misleading extension', async () => {
    const info = await inspectFile(new File([bmpBytes as Uint8Array<ArrayBuffer>], 'disguised.png'));
    expect(info.format.id).toBe('bmp');
    expect(info.dimensions).toEqual({ width: 3, height: 2 });
    expect(info.warnings[0]).toMatch(/named \.png but is actually a BMP/);
  });

  it('rejects empty, oversized, unsupported and unknown files with clear messages', async () => {
    await expect(inspectFile(new File([], 'x.png'))).rejects.toMatchObject({ code: 'EMPTY_FILE' });
    const huge = { size: MAX_FILE_BYTES + 1, name: 'big.png' } as File;
    await expect(inspectFile(huge)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    await expect(inspectFile(new File(['GIF89a......'], 'a.gif'))).rejects.toThrow(/GIF files aren't supported/);
    await expect(inspectFile(new File(['hello'], 'notes.png'))).rejects.toThrow(/doesn't look like/);
  });

  it('rejects images whose header declares too many pixels', () => {
    expect(() => checkDimensions({ width: 20000, height: 10 })).toThrow(ConversionError);
    expect(() => checkDimensions({ width: 10000, height: 10000 })).toThrow(/100\.0 MP/);
    expect(() => checkDimensions({ width: 4000, height: 3000 })).not.toThrow();
  });
});

describe('limits helpers', () => {
  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(25 * 1024 * 1024)).toBe('25 MB');
  });

  it('detects iOS including iPadOS desktop mode', () => {
    expect(isIOS({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', maxTouchPoints: 5, platform: 'iPhone' })).toBe(true);
    expect(isIOS({ userAgent: 'Mozilla/5.0 (Macintosh)', maxTouchPoints: 5, platform: 'MacIntel' })).toBe(true);
    expect(isIOS({ userAgent: 'Mozilla/5.0 (Macintosh)', maxTouchPoints: 0, platform: 'MacIntel' })).toBe(false);
  });
});

describe('zip', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('writes a valid STORE archive with UTF-8 names', async () => {
    const files = [
      { name: 'a.txt', data: new Blob(['hello']) },
      { name: 'café.jpg', data: new Blob([new Uint8Array([1, 2, 3])]) },
    ];
    const zip = new Uint8Array(await (await createZip(files, new Date(2026, 0, 2, 3, 4, 6))).arrayBuffer());
    const v = new DataView(zip.buffer);
    expect(v.getUint32(0, true)).toBe(0x04034b50);
    const eocd = zip.length - 22;
    expect(v.getUint32(eocd, true)).toBe(0x06054b50);
    expect(v.getUint16(eocd + 10, true)).toBe(2);
    const cdOffset = v.getUint32(eocd + 16, true);
    // Walk the central directory and check each local entry.
    let p = cdOffset;
    const names: string[] = [];
    for (let i = 0; i < 2; i++) {
      expect(v.getUint32(p, true)).toBe(0x02014b50);
      expect(v.getUint16(p + 8, true) & 0x0800).toBe(0x0800);
      const nameLen = v.getUint16(p + 28, true);
      const size = v.getUint32(p + 20, true);
      const crc = v.getUint32(p + 16, true);
      const local = v.getUint32(p + 42, true);
      names.push(new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen)));
      const dataStart = local + 30 + v.getUint16(local + 26, true);
      expect(crc32(zip.subarray(dataStart, dataStart + size))).toBe(crc);
      p += 46 + nameLen;
    }
    expect(names).toEqual(['a.txt', 'café.jpg']);
  });
});
