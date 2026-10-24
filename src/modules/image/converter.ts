import { readDimensions, readJpegOrientation, sniff } from '../../core/detect';
import { ConversionError, throwIfAborted } from '../../core/errors';
import { outputFileName } from '../../core/filename';
import { FORMATS, findFormatByExtension, getFormat } from '../../core/formats';
import { checkDimensions } from '../../core/inspect';
import type { ConversionContext, ConversionInput, ConversionResult, ConvertOptions, Converter, FormatInfo } from '../../core/types';
import { formatBytes } from '../../core/limits';
import { encodeBmp, hasTransparency, type RawImage } from './bmp';
import { canvasToBlob, type ImageCapabilities } from './capabilities';
import { fitToSize } from './compress';
import { decodeImage, type DecodedImage } from './decode';
import { applyColour, removeBackground, type BackgroundRemoval } from './edits';
import { jpegToPdf } from './pdf';

const IMAGE_IDS = FORMATS.filter((f) => f.category === 'image').map((f) => f.id);

type WebpEncode = (data: ImageData, options?: { quality?: number }) => Promise<ArrayBuffer>;
let webpEncoder: Promise<WebpEncode> | null = null;

/**
 * Load the WebAssembly WebP encoder. Only used when the browser has no
 * native WebP encoder (e.g. Safari). Load failures and encode failures get
 * different messages, because the user's fix is different.
 */
async function loadWebpEncoder(): Promise<WebpEncode> {
  webpEncoder ??= (async () => {
    const mod = await import('@jsquash/webp/encode');
    await mod.init(); // fetches and compiles the .wasm file
    return mod.default as WebpEncode;
  })();
  try {
    return await webpEncoder;
  } catch (e) {
    webpEncoder = null; // allow a retry once the network is back
    throw new ConversionError(
      'ENCODER_LOAD_FAILED',
      "OpenConverter's built-in WebP encoder couldn't be loaded. Check your internet connection and try again, or choose PNG or JPEG instead.",
      { cause: e },
    );
  }
}

async function encodeWebpWasm(raw: RawImage, quality: number): Promise<Blob> {
  const encode = await loadWebpEncoder();
  try {
    const pixels = new ImageData(raw.data as Uint8ClampedArray<ArrayBuffer>, raw.width, raw.height);
    const buf = await encode(pixels, { quality: Math.round(quality * 100) });
    return new Blob([buf], { type: 'image/webp' });
  } catch (e) {
    throw new ConversionError(
      'ENCODE_FAILED',
      "The built-in WebP encoder couldn't encode this image. It may be too large for this device. Try a smaller image, or choose PNG or JPEG instead.",
      { cause: e },
    );
  }
}

function make2d(width: number, height: number, willReadFrequently: boolean) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d', { willReadFrequently });
  if (!g || canvas.width !== width || canvas.height !== height) {
    throw new ConversionError(
      'OUT_OF_MEMORY',
      `Your browser couldn't allocate a ${width} × ${height} canvas. Try a smaller image.`,
    );
  }
  return { canvas, g, release: () => { canvas.width = canvas.height = 0; } };
}

/**
 * Exact transparency check over the whole canvas at full resolution. Pixels
 * are read in horizontal strips of about 16 MB so memory stays bounded, and
 * the scan stops at the first transparent pixel. Correctness decisions must
 * never rely on a downscaled copy: thin features vanish when shrunk.
 */
export function canvasHasTransparency(g: CanvasRenderingContext2D, width: number, height: number): boolean {
  const rowsPerStrip = Math.max(1, Math.floor(4_000_000 / Math.max(1, width)));
  for (let y = 0; y < height; y += rowsPerStrip) {
    const h = Math.min(rowsPerStrip, height - y);
    if (hasTransparency(g.getImageData(0, y, width, h).data)) return true;
  }
  return false;
}

/**
 * Confirm the encoder produced what we asked for: non-empty, correct
 * signature, canonical MIME type, and a file name whose extension matches.
 * Never offer a file under a misleading name or type.
 */
export async function verifyOutput(blob: Blob | null, target: FormatInfo, fileName: string): Promise<Blob> {
  if (!blob || blob.size === 0) {
    throw new ConversionError(
      'ENCODE_FAILED',
      `Your browser couldn't create the ${target.label} file. This can happen with very large images or when the device is low on memory. Try a smaller image or a different output format.`,
    );
  }
  const head = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
  const actual = sniff(head).formatId;
  if (actual !== target.id) {
    throw new ConversionError(
      'ENCODE_UNSUPPORTED',
      `This browser produced ${actual ? getFormat(actual).label : 'unrecognised data'} instead of ${target.label}, so the file was not saved. Choose a different output format.`,
    );
  }
  if (findFormatByExtension(fileName)?.id !== target.id) {
    throw new ConversionError('ENCODE_FAILED', `Internal error: "${fileName}" doesn't match the ${target.label} format, so it was not saved.`);
  }
  // Re-wrap so the MIME type is exactly the canonical one.
  return blob.type === target.mime ? blob : new Blob([blob], { type: target.mime });
}

/** A size such as "200 KB" for messages. */
const sizeLabel = (bytes: number) => formatBytes(bytes);

function encodeFailed(target: FormatInfo): ConversionError {
  return new ConversionError(
    'ENCODE_FAILED',
    `Your browser couldn't create the ${target.label} file. This can happen with very large images or when the device is low on memory. Try a smaller image or a different output format.`,
  );
}

/** User-facing notes about how background removal went. */
function backgroundNotes(r: BackgroundRemoval, pixels: number, tolerance: number): string[] {
  if (!r.colour) return ["This image's edges are already transparent, so there was no background to remove."];
  if (r.removed === 0) {
    return ['No plain background was found to remove. Background removal works on images with a solid-colour background.'];
  }
  const notes: string[] = [];
  if (r.removed / pixels > 0.97) notes.push(`Almost the whole image matched the background colour. Try a lower tolerance than ${tolerance}.`);
  else if (r.edgeMatch < 0.6) {
    notes.push(
      "The background doesn't look like one plain colour, so parts of it may remain. Background removal works best on product photos, logos and scans with a solid background.",
    );
  }
  return notes;
}

export function createImageConverter(caps: ImageCapabilities): Converter {
  const outputs = [...IMAGE_IDS, 'pdf'];
  return {
    id: 'image-canvas',
    category: 'image',

    outputsFor(fromId) {
      if (!IMAGE_IDS.includes(fromId)) return [];
      return outputs.filter((id) => caps.encoders.has(id));
    },

    async convert(input: ConversionInput, toId: string, options: ConvertOptions, ctx: ConversionContext): Promise<ConversionResult> {
      const target = getFormat(toId);
      const encoder = caps.encoders.get(toId);
      if (!encoder) throw new ConversionError('ENCODE_UNSUPPORTED', `This browser can't create ${target.label} files.`);
      const warnings: string[] = [];
      const quality = Math.min(1, Math.max(0, options.quality));
      const colour = options.colour ?? 'original';
      const removeBg = !!options.removeBackground;
      const tolerance = Math.round(options.bgTolerance ?? 25);
      const edits = colour !== 'original' || removeBg;
      const maxBytes = target.lossy && options.maxBytes && options.maxBytes > 0 ? options.maxBytes : null;

      ctx.onProgress({ fraction: 0.05, stage: 'Reading' });
      let decoded: DecodedImage | null = await decodeImage(input.file, input.format);
      const releases: (() => void)[] = [() => decoded?.close()];

      try {
        const { width, height } = decoded;
        checkDimensions({ width, height });
        if (input.format.id === 'jpeg') {
          // Browsers apply EXIF rotation when decoding. If this one didn't,
          // say so rather than silently producing a sideways image.
          const head = new Uint8Array(await input.file.slice(0, 512 * 1024).arrayBuffer());
          const orientation = readJpegOrientation(head);
          const stored = readDimensions('jpeg', head);
          if (orientation !== null && orientation >= 5 && stored && stored.width !== stored.height &&
              stored.width === width && stored.height === height) {
            warnings.push("This browser didn't apply the photo's rotation setting, so the result may appear sideways.");
          }
        }
        throwIfAborted(ctx.signal);
        ctx.onProgress({ fraction: 0.3, stage: 'Processing' });

        // `hadAlpha` drives the BMP bit depth and the user-facing warnings. It
        // is always computed from full-resolution pixels.
        let hadAlpha = false;
        /** Encodes the prepared pixels at a given quality (ignored by lossless encoders). */
        let encodeAt: (q: number) => Promise<Blob>;

        if (!edits && decoded.raw && target.supportsAlpha && encoder !== 'native') {
          // Fast path for JS-decoded input (BMP) with no edits: exact pixels, no canvas.
          const raw = decoded.raw;
          hadAlpha = hasTransparency(raw.data);
          encodeAt = encoder === 'js'
            ? async () => new Blob([encodeBmp(raw, { alpha: hadAlpha }) as Uint8Array<ArrayBuffer>], { type: target.mime })
            : (q) => encodeWebpWasm(raw, q);
        } else {
          const checkAlphaForFlatten = !target.supportsAlpha && (input.format.supportsAlpha || removeBg);
          const needsPixels = encoder !== 'native' || checkAlphaForFlatten || edits;
          const { canvas, g, release } = make2d(width, height, needsPixels);
          releases.push(release);
          if (decoded.raw) {
            g.putImageData(new ImageData(decoded.raw.data as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
          } else {
            g.drawImage(decoded.source!, 0, 0);
          }
          // Free the decoded source as soon as the canvas holds the pixels.
          decoded.close();
          decoded = null;

          if (edits) {
            throwIfAborted(ctx.signal);
            ctx.onProgress({ fraction: 0.4, stage: removeBg ? 'Removing background' : 'Adjusting colour' });
            // Let the stage label paint before the (synchronous) pixel work.
            await new Promise((r) => setTimeout(r, 0));
            const img = g.getImageData(0, 0, width, height);
            if (removeBg) warnings.push(...backgroundNotes(removeBackground(img.data, width, height, tolerance), width * height, tolerance));
            applyColour(img.data, colour);
            g.putImageData(img, 0, 0);
          }

          if (!target.supportsAlpha) {
            if (checkAlphaForFlatten) hadAlpha = canvasHasTransparency(g, width, height);
            // Always paint the background behind the image for formats without
            // alpha. 'destination-over' only affects non-opaque pixels, so
            // opaque images are unchanged and correctness never depends on
            // detecting transparency first.
            g.globalCompositeOperation = 'destination-over';
            g.fillStyle = options.background;
            g.fillRect(0, 0, width, height);
            g.globalCompositeOperation = 'source-over';
          }
          throwIfAborted(ctx.signal);

          if (toId === 'pdf') {
            // The page image is a JPEG, embedded unchanged in the PDF.
            encodeAt = async (q) => {
              const jpeg = await canvasToBlob(canvas, 'image/jpeg', q);
              if (!jpeg || jpeg.type !== 'image/jpeg' || jpeg.size === 0) throw encodeFailed(target);
              try {
                return new Blob([jpegToPdf(new Uint8Array(await jpeg.arrayBuffer())) as Uint8Array<ArrayBuffer>], { type: target.mime });
              } catch (e) {
                throw new ConversionError('ENCODE_FAILED', "OpenConverter couldn't build the PDF from this image. Try JPEG or PNG instead.", { cause: e });
              }
            };
          } else if (encoder === 'native') {
            encodeAt = async (q) => {
              const b = await canvasToBlob(canvas, target.mime, target.lossy ? q : undefined);
              if (!b) throw encodeFailed(target);
              return b;
            };
          } else {
            const raw: RawImage = { width, height, data: g.getImageData(0, 0, width, height).data };
            if (target.supportsAlpha) hadAlpha = hasTransparency(raw.data);
            encodeAt = encoder === 'js'
              ? async () => new Blob([encodeBmp(raw, { alpha: hadAlpha }) as Uint8Array<ArrayBuffer>], { type: target.mime })
              : (q) => encodeWebpWasm(raw, q);
          }
        }

        throwIfAborted(ctx.signal);
        ctx.onProgress({ fraction: 0.6, stage: maxBytes ? 'Compressing' : 'Encoding' });
        let blob: Blob;
        if (maxBytes) {
          const fit = await fitToSize(encodeAt, maxBytes, quality, ctx.signal);
          blob = fit.blob;
          if (!fit.fits) {
            warnings.push(
              `This image couldn't be compressed under ${sizeLabel(maxBytes)}, even at the lowest quality. The smallest version (${sizeLabel(blob.size)}) was kept. Try a larger limit${toId === 'webp' ? '' : ', or WebP, which is usually smaller'}.`,
            );
          } else if (fit.quality < quality) {
            warnings.push(`Compressed to fit under ${sizeLabel(maxBytes)}, at ${Math.round(fit.quality * 100)}% quality.`);
          }
        } else {
          blob = await encodeAt(quality);
        }

        const flatten = hadAlpha && !target.supportsAlpha;
        if (flatten && removeBg) warnings.push(`The background was replaced with ${options.background}, because ${target.label} can't store transparency. Choose PNG or WebP for a transparent background.`);
        else if (flatten) warnings.push(`Transparent areas were filled with ${options.background}, because ${target.label} can't store transparency.`);
        if (toId === 'bmp' && hadAlpha && !flatten) {
          warnings.push('Saved as a 32-bit BMP with transparency. Some older apps show transparent areas as black.');
        }
        throwIfAborted(ctx.signal);
        ctx.onProgress({ fraction: 0.9, stage: 'Checking' });
        const fileName = outputFileName(input.name, target.extensions[0]!);
        const verified = await verifyOutput(blob, target, fileName);
        ctx.onProgress({ fraction: 1, stage: 'Done' });

        return {
          blob: verified,
          format: target,
          fileName,
          width,
          height,
          warnings,
        };
      } finally {
        for (const r of releases) r();
      }
    },
  };
}
