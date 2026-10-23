import { ConversionError } from '../../core/errors';
import type { FormatInfo } from '../../core/types';
import { BmpUnsupportedError, decodeBmp, type RawImage } from './bmp';

/** A decoded image ready to be drawn. Always call `close()` when finished. */
export interface DecodedImage {
  width: number;
  height: number;
  /** Present when decoded in JS: exact unpremultiplied pixels. */
  raw?: RawImage;
  /** Present when decoded by the browser. */
  source?: CanvasImageSource;
  close(): void;
}

async function viaImageBitmap(blob: Blob): Promise<DecodedImage> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch (e) {
    // Older engines reject unknown option values; retry without options.
    if (e instanceof TypeError) bmp = await createImageBitmap(blob);
    else throw e;
  }
  return { width: bmp.width, height: bmp.height, source: bmp, close: () => bmp.close() };
}

async function viaImageElement(blob: Blob): Promise<DecodedImage> {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.decoding = 'async';
  try {
    img.src = url;
    await img.decode();
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
  return {
    width: img.naturalWidth,
    height: img.naturalHeight,
    source: img,
    close: () => {
      URL.revokeObjectURL(url);
      img.src = '';
    },
  };
}

async function viaBrowser(blob: Blob): Promise<DecodedImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await viaImageBitmap(blob);
    } catch {
      /* fall through to <img> */
    }
  }
  return viaImageElement(blob);
}

export async function decodeImage(file: Blob, format: FormatInfo): Promise<DecodedImage> {
  if (format.id === 'bmp') {
    try {
      const raw = decodeBmp(new Uint8Array(await file.arrayBuffer()));
      return { width: raw.width, height: raw.height, raw, close: () => {} };
    } catch (e) {
      if (!(e instanceof BmpUnsupportedError)) {
        throw new ConversionError('DECODE_FAILED', "This BMP file couldn't be read. It may be damaged.", { cause: e });
      }
      // Unusual BMP variant: let the browser try.
    }
  }
  try {
    return await viaBrowser(file);
  } catch (e) {
    throw new ConversionError(
      'DECODE_FAILED',
      `This browser couldn't open this ${format.label} image. It may be damaged, or use a variant your browser doesn't support.`,
      { cause: e },
    );
  }
}
