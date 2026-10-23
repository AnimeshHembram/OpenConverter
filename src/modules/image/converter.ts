import { sniff } from '../../core/detect';
import { ConversionError, throwIfAborted } from '../../core/errors';
import { outputFileName } from '../../core/filename';
import { FORMATS, getFormat } from '../../core/formats';
import { checkDimensions } from '../../core/inspect';
import type { ConversionContext, ConversionInput, ConversionResult, ConvertOptions, Converter, FormatInfo } from '../../core/types';
import { encodeBmp, hasTransparency, type RawImage } from './bmp';
import { canvasToBlob, type ImageCapabilities } from './capabilities';
import { decodeImage, type DecodedImage } from './decode';

const IMAGE_IDS = FORMATS.filter((f) => f.category === 'image').map((f) => f.id);

/** Lazily loaded only when a browser lacks a native WebP encoder (e.g. Safari). */
async function encodeWebpWasm(raw: RawImage, quality: number): Promise<Blob> {
  const { default: encode } = await import('@jsquash/webp/encode');
  const pixels = new ImageData(raw.data as Uint8ClampedArray<ArrayBuffer>, raw.width, raw.height);
  const buf = await encode(pixels, { quality: Math.round(quality * 100) });
  return new Blob([buf], { type: 'image/webp' });
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

/** Cheap transparency check on a downscaled copy, for browser-decoded images. */
function probeAlpha(src: CanvasImageSource, width: number, height: number): boolean {
  const scale = Math.min(1, 256 / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const { g, release } = make2d(w, h, true);
  try {
    g.drawImage(src, 0, 0, w, h);
    return hasTransparency(g.getImageData(0, 0, w, h).data);
  } finally {
    release();
  }
}

/** Confirm the encoder produced what we asked for. Never mislabel a file. */
async function verifyOutput(blob: Blob | null, target: FormatInfo): Promise<Blob> {
  if (!blob || blob.size === 0) {
    throw new ConversionError('ENCODE_FAILED', `The ${target.label} encoder returned no data.`);
  }
  const head = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
  const actual = sniff(head).formatId;
  if (actual !== target.id) {
    throw new ConversionError(
      'ENCODE_UNSUPPORTED',
      `This browser produced ${actual ? getFormat(actual).label : 'unknown data'} instead of ${target.label}, so the file was not saved.`,
    );
  }
  // Re-wrap so the MIME type is exactly the canonical one.
  return blob.type === target.mime ? blob : new Blob([blob], { type: target.mime });
}

export function createImageConverter(caps: ImageCapabilities): Converter {
  return {
    id: 'image-canvas',
    category: 'image',

    outputsFor(fromId) {
      if (!IMAGE_IDS.includes(fromId)) return [];
      return IMAGE_IDS.filter((id) => caps.encoders.has(id));
    },

    async convert(input: ConversionInput, toId: string, options: ConvertOptions, ctx: ConversionContext): Promise<ConversionResult> {
      const target = getFormat(toId);
      const encoder = caps.encoders.get(toId);
      if (!encoder) throw new ConversionError('ENCODE_UNSUPPORTED', `This browser can't create ${target.label} files.`);
      const warnings: string[] = [];
      const quality = Math.min(1, Math.max(0, options.quality));

      ctx.onProgress({ fraction: 0.05, stage: 'Reading' });
      let decoded: DecodedImage | null = await decodeImage(input.file, input.format);
      const releases: (() => void)[] = [() => decoded?.close()];

      try {
        const { width, height } = decoded;
        checkDimensions({ width, height });
        throwIfAborted(ctx.signal);
        ctx.onProgress({ fraction: 0.35, stage: 'Processing' });

        const hadAlpha = decoded.raw
          ? hasTransparency(decoded.raw.data)
          : input.format.supportsAlpha && decoded.source
            ? probeAlpha(decoded.source, width, height)
            : false;
        const flatten = hadAlpha && !target.supportsAlpha;
        if (flatten) warnings.push(`Transparent areas were filled with ${options.background}, because ${target.label} can't store transparency.`);

        // Fast paths that skip the canvas and keep exact pixel values.
        let blob: Blob | null = null;
        if (decoded.raw && !flatten && (encoder === 'js' || encoder === 'wasm')) {
          ctx.onProgress({ fraction: 0.6, stage: 'Encoding' });
          blob = encoder === 'js'
            ? new Blob([encodeBmp(decoded.raw, { alpha: hadAlpha }) as Uint8Array<ArrayBuffer>], { type: target.mime })
            : await encodeWebpWasm(decoded.raw, quality);
        } else {
          const needsPixels = encoder !== 'native';
          const { canvas, g, release } = make2d(width, height, needsPixels);
          releases.push(release);
          if (decoded.raw) {
            g.putImageData(new ImageData(decoded.raw.data as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
          } else {
            g.drawImage(decoded.source!, 0, 0);
          }
          if (flatten) {
            g.globalCompositeOperation = 'destination-over';
            g.fillStyle = options.background;
            g.fillRect(0, 0, width, height);
            g.globalCompositeOperation = 'source-over';
          }
          // Free the decoded source before encoding to lower peak memory.
          decoded.close();
          decoded = null;
          throwIfAborted(ctx.signal);
          ctx.onProgress({ fraction: 0.6, stage: 'Encoding' });

          if (encoder === 'native') {
            blob = await canvasToBlob(canvas, target.mime, target.lossy ? quality : undefined);
          } else {
            const raw: RawImage = { width, height, data: g.getImageData(0, 0, width, height).data };
            blob = encoder === 'js'
              ? new Blob([encodeBmp(raw, { alpha: hadAlpha && !flatten }) as Uint8Array<ArrayBuffer>], { type: target.mime })
              : await encodeWebpWasm(raw, quality);
          }
        }

        if (toId === 'bmp' && hadAlpha && !flatten) {
          warnings.push('Saved as a 32-bit BMP with transparency. Some older apps show transparent areas as black.');
        }
        throwIfAborted(ctx.signal);
        ctx.onProgress({ fraction: 0.9, stage: 'Checking' });
        const verified = await verifyOutput(blob, target);
        ctx.onProgress({ fraction: 1, stage: 'Done' });

        return {
          blob: verified,
          format: target,
          fileName: outputFileName(input.name, target.extensions[0]!),
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
