import { describe, expect, it } from 'vitest';
import { ConversionError, isAbort, userMessage } from '../../src/core/errors';

describe('userMessage', () => {
  it('passes through ConversionError messages and keeps the cause for debugging', () => {
    const cause = new Error('wasm: CompileError at byte 1234');
    const e = new ConversionError('ENCODER_LOAD_FAILED', 'Friendly text.', { cause });
    expect(userMessage(e)).toBe('Friendly text.');
    expect(e.cause).toBe(cause);
  });

  it('explains unreadable files', () => {
    expect(userMessage(new DOMException('x', 'NotReadableError'))).toMatch(/couldn't be read/);
    expect(userMessage(new DOMException('x', 'NotFoundError'))).toMatch(/moved or deleted/);
  });

  it('explains memory failures', () => {
    expect(userMessage(new RangeError('Array buffer allocation failed'))).toMatch(/ran out of memory/);
  });

  it('never exposes internal details for unknown errors', () => {
    const msg = userMessage(new TypeError('Cannot read properties of undefined (reading "foo")'));
    expect(msg).not.toMatch(/undefined|foo/);
    expect(msg).toMatch(/Try again/);
  });

  it('recognises both kinds of cancellation', () => {
    expect(isAbort(new ConversionError('CANCELLED', 'x'))).toBe(true);
    expect(isAbort(new DOMException('x', 'AbortError'))).toBe(true);
    expect(isAbort(new Error('x'))).toBe(false);
  });
});
