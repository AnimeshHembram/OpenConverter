import { readDimensions, sniff, type Dimensions } from './detect';
import { ConversionError } from './errors';
import { extensionOf, findFormatByExtension, findFormatById } from './formats';
import { MAX_DIMENSION, MAX_FILE_BYTES, formatBytes, formatMegapixels, maxPixels } from './limits';
import type { FormatInfo } from './types';

export interface InspectedFile {
  format: FormatInfo;
  dimensions: Dimensions | null;
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

  const warnings: string[] = [];
  const byExt = findFormatByExtension(file.name);
  if (extensionOf(file.name) && byExt?.id !== format.id) {
    warnings.push(`The file is named .${extensionOf(file.name)} but is actually a ${format.label} image.`);
  }

  const dimensions = readDimensions(format.id, head);
  if (dimensions) checkDimensions(dimensions);
  return { format, dimensions, warnings };
}

export function checkDimensions({ width, height }: Dimensions): void {
  if (width <= 0 || height <= 0) {
    throw new ConversionError('DECODE_FAILED', 'This image reports invalid dimensions and may be damaged.');
  }
  const limit = maxPixels();
  if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > limit) {
    throw new ConversionError(
      'IMAGE_TOO_LARGE',
      `This image is ${width} × ${height} (${formatMegapixels(width * height)}). ` +
        `This browser can safely handle up to ${formatMegapixels(limit)} and ${MAX_DIMENSION}px per side.`,
    );
  }
}
