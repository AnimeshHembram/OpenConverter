import { detectAnimation, orientedDimensions, readDimensions, readJpegOrientation, sniff, type Dimensions } from './detect';
import { ConversionError } from './errors';
import { extensionOf, findFormatByExtension, findFormatById } from './formats';
import { MAX_DIMENSION, MAX_FILE_BYTES, formatBytes, formatMegapixels, pixelPolicy, type PixelPolicy } from './limits';
import type { FormatInfo } from './types';

export interface InspectedFile {
  format: FormatInfo;
  /** As displayed and converted, i.e. after EXIF orientation. */
  dimensions: Dimensions | null;
  /** EXIF orientation for JPEG (1–8), else null. */
  orientation: number | null;
  /** True/false when known from the header, null when it couldn't be determined. */
  animated: boolean | null;
  warnings: string[];
}

// JPEG headers can sit behind large EXIF/ICC blocks, so read generously.
const HEADER_BYTES = 512 * 1024;

/**
 * Validate a user-supplied file and identify its real format from its bytes.
 * Throws ConversionError with a user-facing message when the file is rejected.
 */
export async function inspectFile(file: File): Promise<InspectedFile> {
  if (file.size === 0) throw new ConversionError('EMPTY_FILE', 'This file is empty.');
  if (file.size > MAX_FILE_BYTES) {
    throw new ConversionError(
      'FILE_TOO_LARGE',
      `This file is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_FILE_BYTES)} per file.`,
    );
  }

  const head = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer());
  const sniffed = sniff(head);
  if (!sniffed.formatId) {
    const what = sniffed.knownUnsupported
      ? `${sniffed.knownUnsupported} files aren't supported yet.`
      : "This doesn't look like a PNG, JPEG, WebP or BMP image.";
    throw new ConversionError('UNSUPPORTED_FORMAT', what);
  }
  const format = findFormatById(sniffed.formatId)!;
  if (format.category !== 'image') {
    // PDF is an output format only, for now.
    throw new ConversionError('UNSUPPORTED_FORMAT', `${format.label} files can't be converted yet. OpenConverter can save images as PDFs, but not the other way round.`);
  }

  const warnings: string[] = [];
  const byExt = findFormatByExtension(file.name);
  if (extensionOf(file.name) && byExt?.id !== format.id) {
    warnings.push(`The file is named .${extensionOf(file.name)} but is actually a ${format.label} image.`);
  }

  const orientation = format.id === 'jpeg' ? readJpegOrientation(head) : null;
  const stored = readDimensions(format.id, head);
  const dimensions = stored ? orientedDimensions(stored, orientation) : null;
  if (dimensions) checkDimensions(dimensions);

  const animated = detectAnimation(format.id, head);
  if (animated) {
    const kind = format.id === 'png' ? 'an animated PNG (APNG)' : 'an animated WebP';
    warnings.push(`This is ${kind}. Only the first frame will be converted; the animation won't be kept.`);
  }
  return { format, dimensions, orientation, animated, warnings };
}

export function checkDimensions({ width, height }: Dimensions, policy: PixelPolicy = pixelPolicy()): void {
  if (!(width > 0 && height > 0)) {
    throw new ConversionError('DECODE_FAILED', 'This image reports invalid dimensions and may be damaged.');
  }
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new ConversionError(
      'IMAGE_TOO_LARGE',
      `This image is ${width} × ${height}. OpenConverter can handle up to ${MAX_DIMENSION.toLocaleString('en')} pixels per side. Resize it first, then try again.`,
    );
  }
  if (width * height > policy.maxPixels) {
    throw new ConversionError(
      'IMAGE_TOO_LARGE',
      `This image is ${width} × ${height} (${formatMegapixels(width * height)}). On this device the limit is ` +
        `${formatMegapixels(policy.maxPixels)}, because ${policy.reason}. Resize it first, or try on a computer.`,
    );
  }
}
