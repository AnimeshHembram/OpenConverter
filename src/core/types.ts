/**
 * Shared types for every conversion module (images now, documents later).
 *
 * A module registers one or more `Converter`s with the registry. The UI never
 * talks to a module directly: it asks the registry which outputs are possible
 * for a detected input format and hands jobs to whichever converter answers.
 */

export type FormatCategory = 'image' | 'document';

export interface FormatInfo {
  /** Stable identifier, e.g. "png", "jpeg", "pdf". */
  id: string;
  /** Human label, e.g. "JPEG". */
  label: string;
  /** Canonical MIME type written on output blobs. */
  mime: string;
  /** Extra MIME types browsers report for this format on input. */
  altMimes?: readonly string[];
  /** Lower-case extensions without the dot. The first is used for output names. */
  extensions: readonly string[];
  category: FormatCategory;
  /** Lossy formats expose a quality setting. */
  lossy: boolean;
  /** Whether the format can store an alpha channel. */
  supportsAlpha: boolean;
  /** False for formats that are recognised but can't be converted from yet. Default true. */
  input?: boolean;
  /** Shown when a file of this format is rejected as input. */
  inputMessage?: string;
}

/** Colour treatment applied before encoding. */
export type ColourMode = 'original' | 'grayscale' | 'bw';

export interface ConvertOptions {
  /** 0..1 for lossy encoders. Ignored for lossless formats. */
  quality: number;
  /** CSS colour used to fill transparent areas when the output cannot store alpha. */
  background: string;
  /** Default 'original'. 'bw' is two-tone black and white. */
  colour?: ColourMode;
  /** Make a plain, solid-colour background transparent (filled with `background` for formats without alpha). */
  removeBackground?: boolean;
  /** 0..100: how far a pixel's colour may be from the background colour and still be removed. */
  bgTolerance?: number;
  /** Lossy outputs only: the largest acceptable file size in bytes. Quality is lowered until it fits. */
  maxBytes?: number | null;
}

export interface ProgressInfo {
  /** 0..1 */
  fraction: number;
  stage: string;
}

export interface ConversionContext {
  signal: AbortSignal;
  onProgress: (p: ProgressInfo) => void;
}

export interface ConversionInput {
  file: Blob;
  name: string;
  format: FormatInfo;
}

export interface ConversionResult {
  blob: Blob;
  format: FormatInfo;
  fileName: string;
  width?: number;
  height?: number;
  /** Non-fatal notes, e.g. "Transparent areas were filled with white." */
  warnings: string[];
}

export interface Converter {
  id: string;
  category: FormatCategory;
  /** Output format ids this converter can produce from `fromId`, in this browser. */
  outputsFor(fromId: string): string[];
  /** Why `fromId` can't be converted here, when the format is known but unavailable (e.g. offline). */
  unavailableReason?(fromId: string): string | undefined;
  convert(
    input: ConversionInput,
    toId: string,
    options: ConvertOptions,
    ctx: ConversionContext,
  ): Promise<ConversionResult>;
}
