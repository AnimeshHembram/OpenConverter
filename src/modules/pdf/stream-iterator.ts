/**
 * `for await (const chunk of readableStream)` for browsers that lack it.
 *
 * pdf.js 6 reads page text with `for await (… of readableStream)` (in
 * `getTextContent`) and uses the same pattern when decompressing some images.
 * Async iteration of ReadableStream only arrived in Safari 27, so in Safari
 * 26 and earlier (and Playwright's WebKit) every text extraction threw
 * "TypeError: … is not async iterable": PDF → text, Markdown and Word failed
 * while PDF → images still worked.
 *
 * This adds the standard `values()` / `[Symbol.asyncIterator]` methods only
 * when the browser has none, following the Streams spec: the stream is
 * locked while iterating, cancelled if the loop exits early (unless
 * `preventCancel` is set), and unlocked afterwards.
 */

interface IterableProto {
  getReader(): ReadableStreamDefaultReader<unknown>;
  values?: unknown;
  [Symbol.asyncIterator]?: unknown;
}

/** Iterate a stream's chunks with a reader, as the spec's async iterator does. */
export async function* streamValues<T>(stream: ReadableStream<T>, options?: { preventCancel?: boolean }): AsyncGenerator<T, void, undefined> {
  const reader = stream.getReader();
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        return;
      }
      yield value;
    }
  } catch (e) {
    finished = true; // an errored stream needs no cancelling
    throw e;
  } finally {
    if (!finished && !options?.preventCancel) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * Install the iterator on `proto` (ReadableStream.prototype by default) if
 * it has none. Returns true if it was installed. Never replaces a native one.
 */
export function installStreamIterator(proto: IterableProto | undefined = globalThis.ReadableStream?.prototype as IterableProto | undefined): boolean {
  if (!proto || typeof proto[Symbol.asyncIterator] === 'function') return false;
  function values(this: ReadableStream<unknown>, options?: { preventCancel?: boolean }) {
    return streamValues(this, options);
  }
  const descriptor = { value: values, writable: true, configurable: true, enumerable: false };
  if (typeof proto.values !== 'function') Object.defineProperty(proto, 'values', descriptor);
  Object.defineProperty(proto, Symbol.asyncIterator, descriptor);
  return true;
}
