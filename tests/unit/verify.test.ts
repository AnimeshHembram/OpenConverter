import { describe, expect, it } from 'vitest';
import { getFormat } from '../../src/core/formats';
import { verifyOutput } from '../../src/modules/image/converter';
import { encodeBmp } from '../../src/modules/image/bmp';

const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

describe('verifyOutput (every encoder path goes through this)', () => {
  it('rejects a missing or empty result with an actionable message', async () => {
    await expect(verifyOutput(null, getFormat('jpeg'), 'a.jpg')).rejects.toMatchObject({ code: 'ENCODE_FAILED' });
    await expect(verifyOutput(new Blob([]), getFormat('jpeg'), 'a.jpg')).rejects.toThrow(/Try a smaller image/);
  });

  it('refuses a browser fallback that silently produced a different format', async () => {
    // Safari's canvas.toBlob("image/webp") returns a PNG.
    const fake = new Blob([PNG_HEAD], { type: 'image/png' });
    await expect(verifyOutput(fake, getFormat('webp'), 'a.webp')).rejects.toThrow(/produced PNG instead of WebP/);
  });

  it('refuses data whose bytes are not an image at all', async () => {
    await expect(verifyOutput(new Blob(['hello']), getFormat('png'), 'a.png')).rejects.toThrow(/unrecognised data/);
  });

  it('refuses a file name whose extension does not match the format', async () => {
    await expect(verifyOutput(new Blob([PNG_HEAD]), getFormat('png'), 'a.jpg')).rejects.toMatchObject({ code: 'ENCODE_FAILED' });
  });

  it('accepts a correct result and normalises the MIME type', async () => {
    const bmp = encodeBmp({ width: 1, height: 1, data: new Uint8ClampedArray(4) }, { alpha: false });
    const out = await verifyOutput(new Blob([bmp as Uint8Array<ArrayBuffer>], { type: 'image/x-ms-bmp' }), getFormat('bmp'), 'x.bmp');
    expect(out.type).toBe('image/bmp');
    expect(out.size).toBe(bmp.length);
    const png = await verifyOutput(new Blob([PNG_HEAD], { type: 'image/png' }), getFormat('png'), 'x.png');
    expect(png.type).toBe('image/png');
  });
});
