/**
 * Byte-level builders for test fixtures (APNG, animated WebP, EXIF JPEG).
 * Used by unit tests and by make-fixtures.mjs, which turns real
 * browser-encoded images into the committed binary fixtures.
 */
import { crc32 } from '../../src/core/zip';

const enc = new TextEncoder();
const u32be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16be = (n: number) => [(n >>> 8) & 255, n & 255];
const u24le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
const u32le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];

function concat(parts: (Uint8Array | number[])[]): Uint8Array {
  const arrs = parts.map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p)));
  const out = new Uint8Array(arrs.reduce((s, a) => s + a.length, 0));
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

export function pngChunk(type: string, data: Uint8Array | number[]): Uint8Array {
  const body = concat([enc.encode(type), data]);
  return concat([u32be(body.length - 4), body, u32be(crc32(body))]);
}

interface PngChunk { type: string; data: Uint8Array }

export function parsePngChunks(png: Uint8Array): PngChunk[] {
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out: PngChunk[] = [];
  let o = 8;
  while (o + 8 <= png.length) {
    const len = v.getUint32(o);
    const type = String.fromCharCode(...png.subarray(o + 4, o + 8));
    out.push({ type, data: png.subarray(o + 8, o + 8 + len) });
    o += 12 + len;
  }
  return out;
}

/** Turn a static PNG into a valid 2-frame APNG whose frames are identical. */
export function pngToApng(png: Uint8Array, frames = 2): Uint8Array {
  const chunks = parsePngChunks(png);
  const ihdr = chunks.find((c) => c.type === 'IHDR')!;
  const w = new DataView(ihdr.data.buffer, ihdr.data.byteOffset).getUint32(0);
  const h = new DataView(ihdr.data.buffer, ihdr.data.byteOffset).getUint32(4);
  const idat = concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  let seq = 0;
  const fctl = () => pngChunk('fcTL', [...u32be(seq++), ...u32be(w), ...u32be(h), ...u32be(0), ...u32be(0), ...u16be(1), ...u16be(10), 0, 0]);
  const parts: Uint8Array[] = [png.subarray(0, 8), pngChunk('IHDR', ihdr.data), pngChunk('acTL', [...u32be(frames), ...u32be(0)])];
  parts.push(fctl(), pngChunk('IDAT', idat));
  for (let i = 1; i < frames; i++) {
    parts.push(fctl());
    parts.push(pngChunk('fdAT', concat([u32be(seq++), idat])));
  }
  parts.push(pngChunk('IEND', []));
  return concat(parts);
}

function riffChunk(type: string, data: Uint8Array | number[]): Uint8Array {
  const d = data instanceof Uint8Array ? data : new Uint8Array(data);
  return concat([enc.encode(type), u32le(d.length), d, d.length % 2 ? [0] : []]);
}

/**
 * Wrap a still WebP (simple or extended layout) as an animated WebP with
 * `frames` identical frames.
 */
export function webpToAnimated(webp: Uint8Array, width: number, height: number, frames = 2): Uint8Array {
  const v = new DataView(webp.buffer, webp.byteOffset, webp.byteLength);
  // Collect the image chunks (ALPH, VP8, VP8L); skip VP8X and metadata.
  const imageChunks: Uint8Array[] = [];
  let hasAlpha = false;
  for (let o = 12; o + 8 <= webp.length; ) {
    const type = String.fromCharCode(...webp.subarray(o, o + 4));
    const len = v.getUint32(o + 4, true);
    const end = o + 8 + len + (len % 2);
    if (type === 'ALPH' || type === 'VP8 ' || type === 'VP8L') imageChunks.push(webp.subarray(o, end));
    if (type === 'ALPH' || type === 'VP8L') hasAlpha = true;
    o = end;
  }
  if (!imageChunks.length) throw new Error('no WebP image data found');
  const frameData = concat(imageChunks);
  const vp8x = riffChunk('VP8X', [0x02 | (hasAlpha ? 0x10 : 0), 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)]);
  const anim = riffChunk('ANIM', [0, 0, 0, 0, 0, 0]);
  const anmf = riffChunk('ANMF', concat([[...u24le(0), ...u24le(0), ...u24le(width - 1), ...u24le(height - 1), ...u24le(100), 0], frameData]));
  const body = concat([enc.encode('WEBP'), vp8x, anim, ...Array.from({ length: frames }, () => anmf)]);
  return concat([enc.encode('RIFF'), u32le(body.length), body]);
}

/** Insert an EXIF APP1 segment with the given orientation right after SOI. */
export function jpegWithOrientation(jpeg: Uint8Array, orientation: number, littleEndian = true): Uint8Array {
  const r16 = (n: number) => (littleEndian ? [n & 255, n >> 8] : [n >> 8, n & 255]);
  const r32 = (n: number) => (littleEndian ? u32le(n) : u32be(n));
  const tiff = [
    ...(littleEndian ? [0x49, 0x49] : [0x4d, 0x4d]),
    ...r16(42),
    ...r32(8),
    ...r16(1), // one IFD entry
    ...r16(0x0112), ...r16(3), ...r32(1), ...r16(orientation), 0, 0,
    ...r32(0), // no next IFD
  ];
  const payload = concat([enc.encode('Exif\0\0'), tiff]);
  const app1 = concat([[0xff, 0xe1], u16be(payload.length + 2), payload]);
  return concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}
