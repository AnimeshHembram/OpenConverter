import { describe, expect, it } from 'vitest';
import { installStreamIterator, streamValues } from '../../src/modules/pdf/stream-iterator';

/** A stream of the given chunks that records whether it was cancelled. */
function source(chunks: number[], opts: { failAt?: number } = {}) {
  const log = { cancelled: false };
  let i = 0;
  const stream = new ReadableStream<number>({
    pull(c) {
      if (opts.failAt === i) c.error(new Error('broken'));
      else if (i < chunks.length) c.enqueue(chunks[i++]!);
      else c.close();
    },
    cancel() {
      log.cancelled = true;
    },
  });
  return { stream, log };
}

describe('streamValues (ReadableStream async iteration for Safari 26 and earlier)', () => {
  it('yields every chunk in order and unlocks the stream', async () => {
    const { stream, log } = source([1, 2, 3]);
    const seen: number[] = [];
    for await (const v of streamValues(stream)) seen.push(v);
    expect(seen).toEqual([1, 2, 3]);
    expect(stream.locked).toBe(false);
    expect(log.cancelled).toBe(false);
  });

  it('cancels the stream when the loop exits early, unless preventCancel is set', async () => {
    const a = source([1, 2, 3]);
    for await (const v of streamValues(a.stream)) if (v === 1) break;
    expect(a.log.cancelled).toBe(true);
    expect(a.stream.locked).toBe(false);

    const b = source([1, 2, 3]);
    for await (const v of streamValues(b.stream, { preventCancel: true })) if (v === 1) break;
    expect(b.log.cancelled).toBe(false);
    expect(b.stream.locked).toBe(false);
    // The rest is still readable.
    const rest: number[] = [];
    for await (const v of streamValues(b.stream)) rest.push(v);
    expect(rest).toEqual([2, 3]);
  });

  it('passes on stream errors and unlocks the stream', async () => {
    const { stream } = source([1, 2], { failAt: 1 });
    const seen: number[] = [];
    await expect(
      (async () => {
        for await (const v of streamValues(stream)) seen.push(v);
      })(),
    ).rejects.toThrow('broken');
    expect(seen).toEqual([1]);
    expect(stream.locked).toBe(false);
  });
});

describe('installStreamIterator', () => {
  it('adds values() and Symbol.asyncIterator where they are missing, so for await works', async () => {
    class Legacy {
      constructor(private readonly inner: ReadableStream<number>) {}
      getReader() {
        return this.inner.getReader();
      }
    }
    expect(installStreamIterator(Legacy.prototype as never)).toBe(true);
    const proto = Legacy.prototype as unknown as Record<PropertyKey, unknown>;
    expect(typeof proto[Symbol.asyncIterator]).toBe('function');
    expect(typeof proto.values).toBe('function');
    expect(Object.keys(Legacy.prototype)).not.toContain('values'); // not enumerable, like the native ones
    const seen: number[] = [];
    for await (const v of new Legacy(source([4, 5]).stream) as unknown as AsyncIterable<number>) seen.push(v);
    expect(seen).toEqual([4, 5]);
  });

  it('never replaces a native implementation', () => {
    const proto = ReadableStream.prototype as unknown as Record<PropertyKey, unknown>;
    const native = proto[Symbol.asyncIterator];
    expect(typeof native).toBe('function');
    expect(installStreamIterator()).toBe(false);
    expect(proto[Symbol.asyncIterator]).toBe(native);
  });
});
