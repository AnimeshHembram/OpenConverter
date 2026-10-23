export type ErrorCode =
  | 'UNSUPPORTED_FORMAT'
  | 'EMPTY_FILE'
  | 'FILE_TOO_LARGE'
  | 'IMAGE_TOO_LARGE'
  | 'DECODE_FAILED'
  | 'ENCODE_UNSUPPORTED'
  | 'ENCODER_LOAD_FAILED'
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

/**
 * A message that is safe and useful to show the user. The original error
 * stays available (as `cause`, or logged) for debugging; internals such as
 * stack traces are never shown.
 */
export function userMessage(err: unknown): string {
  if (err instanceof ConversionError) return err.message;
  if (err instanceof DOMException && (err.name === 'NotReadableError' || err.name === 'NotFoundError')) {
    return "This file couldn't be read. It may have been moved or deleted, or the browser lost access to it. Try adding it again.";
  }
  if (err instanceof DOMException && err.name === 'AbortError') return 'Conversion cancelled.';
  if (err instanceof RangeError || (err instanceof Error && /out of memory|allocation failed/i.test(err.message))) {
    return 'Your browser ran out of memory. Try a smaller image or convert fewer files at once.';
  }
  return 'Something went wrong while converting this file. Try again, or try a different output format.';
}
