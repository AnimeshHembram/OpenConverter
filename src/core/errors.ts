export type ErrorCode =
  | 'UNSUPPORTED_FORMAT'
  | 'EMPTY_FILE'
  | 'FILE_TOO_LARGE'
  | 'IMAGE_TOO_LARGE'
  | 'DECODE_FAILED'
  | 'ENCODE_UNSUPPORTED'
  | 'ENCODE_FAILED'
  | 'OUT_OF_MEMORY'
  | 'NO_CONVERTER'
  | 'CANCELLED';

/** An error whose `message` is safe and useful to show to the user. */
export class ConversionError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ConversionError';
    this.code = code;
  }
}

export function isAbort(err: unknown): boolean {
  return (
    (err instanceof ConversionError && err.code === 'CANCELLED') ||
    (err instanceof DOMException && err.name === 'AbortError')
  );
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ConversionError('CANCELLED', 'Conversion cancelled.');
}

export function userMessage(err: unknown): string {
  if (err instanceof ConversionError) return err.message;
  if (err instanceof RangeError || (err instanceof Error && /memory/i.test(err.message))) {
    return 'Your browser ran out of memory. Try a smaller image or convert fewer files at once.';
  }
  return 'Something went wrong while converting this file.';
}
