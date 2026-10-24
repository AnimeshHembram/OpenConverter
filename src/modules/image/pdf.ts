/**
 * Minimal PDF writer: one page showing one JPEG image. The JPEG bytes are
 * embedded unchanged (PDF's DCTDecode filter reads JPEG natively), so no
 * library is needed and the output is exactly as sharp as the JPEG.
 *
 * The page is sized to the image at 96 pixels per inch, the same size the
 * image appears at 100% zoom in a browser.
 */

export interface JpegFrame {
  width: number;
  height: number;
  /** 1 = greyscale, 3 = colour (YCbCr/RGB), 4 = CMYK. */
  components: number;
}

/** Read the frame header (SOF) of a JPEG: dimensions and component count. */
export function readJpegFrame(b: Uint8Array): JpegFrame | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let o = 2;
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) return null;
    const marker = b[o + 1]!;
    if (marker === 0xff) {
      o++;
      continue;
    }
    const len = (b[o + 2]! << 8) | b[o + 3]!;
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        height: (b[o + 5]! << 8) | b[o + 6]!,
        width: (b[o + 7]! << 8) | b[o + 8]!,
        components: b[o + 9]!,
      };
    }
    if (marker === 0xda || marker === 0xd9) return null; // scan or end before a frame header
    o += 2 + len;
  }
  return null;
}

const COLOUR_SPACE: Record<number, string> = { 1: '/DeviceGray', 3: '/DeviceRGB', 4: '/DeviceCMYK' };

/** Page size in PDF points (1/72 inch) for an image shown at 96 px per inch. */
export function pageSize(width: number, height: number): { w: number; h: number } {
  const pt = (px: number) => Math.round(px * 75) / 100; // px * 72 / 96, to 2 decimals
  return { w: pt(width), h: pt(height) };
}

/** Wrap one JPEG in a single-page PDF. Throws if the bytes aren't a usable JPEG. */
export function jpegToPdf(jpeg: Uint8Array): Uint8Array {
  const frame = readJpegFrame(jpeg);
  if (!frame || !frame.width || !frame.height || !COLOUR_SPACE[frame.components]) {
    throw new Error('The page image is not a JPEG this PDF writer supports.');
  }
  const { w, h } = pageSize(frame.width, frame.height);
  const enc = new TextEncoder(); // headers are ASCII
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let size = 0;
  const add = (p: Uint8Array | string) => {
    const bytes = typeof p === 'string' ? enc.encode(p) : p;
    parts.push(bytes);
    size += bytes.length;
  };
  const obj = (n: number, body: string) => {
    offsets[n] = size;
    add(`${n} 0 obj\n${body}\nendobj\n`);
  };

  // The binary comment marks the file as binary for transfer tools.
  add(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // "%PDF-1.4\n%âãÏÓ\n"
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  offsets[4] = size;
  add(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${frame.width} /Height ${frame.height} ` +
      `/ColorSpace ${COLOUR_SPACE[frame.components]} /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
  );
  add(jpeg);
  add('\nendstream\nendobj\n');
  const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
  obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  obj(6, '<< /Producer (OpenConverter) >>');

  const xref = size;
  let table = `xref\n0 7\n0000000000 65535 f \n`;
  for (let n = 1; n <= 6; n++) table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  add(`${table}trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
