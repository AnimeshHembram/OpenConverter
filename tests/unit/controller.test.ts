import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Controller } from '../../src/app/controller';
import { ConversionError } from '../../src/core/errors';
import { getFormat } from '../../src/core/formats';
import { MAX_BATCH_FILES } from '../../src/core/limits';
import { _resetRegistry, registerConverter } from '../../src/core/registry';
import type { ConversionContext, ConversionInput, Converter } from '../../src/core/types';
import { encodeBmp } from '../../src/modules/image/bmp';

/**
 * Controller lifecycle tests with a fake converter whose jobs the test
 * resolves, rejects or aborts explicitly, so races are deterministic.
 */

interface Job {
  name: string;
  ctx: ConversionContext;
  resolve: () => void;
  reject: (e: unknown) => void;
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1]);

function bmpFile(name: string): File {
  const bytes = encodeBmp({ width: 2, height: 2, data: new Uint8ClampedArray(16).fill(255) }, { alpha: false });
  return new File([bytes as Uint8Array<ArrayBuffer>], name, { type: 'image/bmp' });
}

let jobs: Job[];
/** When false, the fake converter ignores cancellation (like a stuck encoder). */
let honourAbort = true;
let started: Promise<void>;
let notifyStarted: () => void;

function fakeConverter(): Converter {
  return {
    id: 'fake',
    category: 'image',
    outputsFor: (from) => (from === 'bmp' ? ['png'] : []),
    convert(input: ConversionInput, _to, _opts, ctx) {
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(new ConversionError('CANCELLED', 'Conversion cancelled.'));
        if (honourAbort) {
          if (ctx.signal.aborted) return onAbort();
          ctx.signal.addEventListener('abort', onAbort, { once: true });
        }
        jobs.push({
          name: input.name,
          ctx,
          resolve: () =>
            resolve({
              blob: new Blob([PNG_BYTES], { type: 'image/png' }),
              format: getFormat('png'),
              fileName: input.name.replace(/\.\w+$/, '.png'),
              warnings: [],
            }),
          reject,
        });
        notifyStarted();
      });
    },
  };
}

function nextStart(): Promise<void> {
  started = new Promise((r) => (notifyStarted = r));
  return started;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function setup(names: string[]) {
  const c = new Controller({ target: 'png', quality: 0.8, background: '#ffffff' });
  await c.addFiles(names.map(bmpFile));
  return c;
}

beforeEach(() => {
  _resetRegistry();
  registerConverter(fakeConverter());
  jobs = [];
  honourAbort = true;
  nextStart();
});
afterEach(() => _resetRegistry());

describe('Controller lifecycle', () => {
  it('inspects added files, announces them, and creates one preview URL each', async () => {
    const c = await setup(['a.bmp', 'b.bmp']);
    expect(c.snapshot.items.map((i) => i.status)).toEqual(['ready', 'ready']);
    expect(c.snapshot.notice).toEqual({ kind: 'info', text: '2 files added.' });
    expect(c.liveObjectUrls).toBe(2);
  });

  it('converts sequentially and reports success', async () => {
    const c = await setup(['a.bmp', 'b.bmp']);
    const run = c.convertAll();
    await started;
    expect(jobs).toHaveLength(1); // one at a time
    nextStart();
    jobs[0]!.resolve();
    await started;
    jobs[1]!.resolve();
    await run;
    expect(c.snapshot.items.map((i) => i.status)).toEqual(['done', 'done']);
    expect(c.snapshot.notice).toEqual({ kind: 'info', text: '2 files converted.' });
    expect(c.liveObjectUrls).toBe(4);
    expect(c.snapshot.running).toBe(false);
  });

  it('removing the file being converted cancels only that file, and its result never reappears', async () => {
    const c = await setup(['a.bmp', 'b.bmp']);
    const run = c.convertAll();
    await started;
    const firstId = c.snapshot.items[0]!.id;
    nextStart();
    c.remove(firstId);
    expect(jobs[0]!.ctx.signal.aborted).toBe(true);
    await started; // second file starts
    jobs[1]!.resolve();
    await run;
    expect(c.snapshot.items.map((i) => i.name)).toEqual(['b.bmp']);
    expect(c.snapshot.items[0]!.status).toBe('done');
    expect(c.liveObjectUrls).toBe(2); // b's preview + result; a's preview revoked
  });

  it('a late result for a removed file is discarded without creating a URL', async () => {
    honourAbort = false;
    const c = await setup(['a.bmp']);
    const run = c.convertAll();
    await started;
    const job = jobs[0]!;
    c.remove(c.snapshot.items[0]!.id);
    expect(job.ctx.signal.aborted).toBe(true);
    job.resolve(); // the converter ignored the abort and finished anyway
    await run;
    expect(c.snapshot.items).toEqual([]);
    expect(c.liveObjectUrls).toBe(0);
  });

  it('cancel stops the batch, keeps finished results, and returns the rest to ready', async () => {
    const c = await setup(['a.bmp', 'b.bmp', 'c.bmp']);
    const run = c.convertAll();
    await started;
    nextStart();
    jobs[0]!.resolve();
    await started; // b is converting
    c.cancel();
    await run;
    expect(c.snapshot.items.map((i) => i.status)).toEqual(['done', 'ready', 'ready']);
    expect(jobs).toHaveLength(2); // c never started
    expect(c.snapshot.notice).toEqual({ kind: 'info', text: 'Conversion cancelled. 1 file converted.' });
    expect(c.snapshot.running).toBe(false);
  });

  it('a failure part-way through a batch does not stop the remaining files', async () => {
    const c = await setup(['a.bmp', 'b.bmp', 'c.bmp']);
    const run = c.convertAll();
    await started;
    nextStart();
    jobs[0]!.resolve();
    await started;
    nextStart();
    jobs[1]!.reject(new ConversionError('ENCODE_FAILED', 'Encoder exploded.'));
    await started;
    jobs[2]!.resolve();
    await run;
    expect(c.snapshot.items.map((i) => i.status)).toEqual(['done', 'error', 'done']);
    expect(c.snapshot.items[1]!.error).toBe('Encoder exploded.');
    expect(c.snapshot.notice).toEqual({ kind: 'error', text: "1 file couldn't be converted. See the details below." });
    expect(c.liveObjectUrls).toBe(5); // 3 previews + 2 results
  });

  it('unexpected exceptions get a safe message and the batch still finishes', async () => {
    const c = await setup(['a.bmp']);
    const run = c.convertAll();
    await started;
    jobs[0]!.reject(new TypeError('internal detail: x is undefined'));
    await run;
    expect(c.snapshot.items[0]!.error).toBe('Something went wrong while converting this file. Try again, or try a different output format.');
    expect(c.snapshot.running).toBe(false);
  });

  it('clearing during a conversion releases everything and leaves no stale notice', async () => {
    const c = await setup(['a.bmp', 'b.bmp']);
    const run = c.convertAll();
    await started;
    c.clear();
    await run;
    expect(c.snapshot.items).toEqual([]);
    expect(c.snapshot.notice).toBeUndefined();
    expect(c.snapshot.running).toBe(false);
    expect(c.liveObjectUrls).toBe(0);
  });

  it('re-converting after a settings change replaces (and revokes) the old result URL', async () => {
    const c = await setup(['a.bmp']);
    let run = c.convertAll();
    await started;
    nextStart();
    jobs[0]!.resolve();
    await run;
    const oldUrl = c.snapshot.items[0]!.result!.url;
    c.setSettings({ background: '#000000' });
    expect(c.downloadableItems()).toHaveLength(0); // stale results aren't offered
    run = c.convertAll();
    await started;
    jobs[1]!.resolve();
    await run;
    expect(c.snapshot.items[0]!.result!.url).not.toBe(oldUrl);
    expect(c.liveObjectUrls).toBe(2);
    expect(c.downloadableItems()).toHaveLength(1);
  });

  it('announces files that cannot be converted', async () => {
    const c = new Controller({ target: 'png', quality: 0.8, background: '#ffffff' });
    await c.addFiles([bmpFile('ok.bmp'), new File(['nope'], 'bad.png')]);
    expect(c.snapshot.notice).toEqual({ kind: 'error', text: "1 file can't be converted. See the details below." });
  });

  it('files removed while still being inspected never get a preview URL', async () => {
    const c = new Controller({ target: 'png', quality: 0.8, background: '#ffffff' });
    const adding = c.addFiles([bmpFile('a.bmp')]);
    c.remove(c.snapshot.items[0]!.id);
    await adding;
    await tick();
    expect(c.snapshot.items).toEqual([]);
    expect(c.liveObjectUrls).toBe(0);
  });

  it(`accepts exactly ${MAX_BATCH_FILES} files and skips the rest with a message`, async () => {
    const c = new Controller({ target: 'png', quality: 0.8, background: '#ffffff' });
    const file = bmpFile('x.bmp');
    await c.addFiles(Array.from({ length: MAX_BATCH_FILES }, () => file));
    expect(c.snapshot.items).toHaveLength(MAX_BATCH_FILES);
    expect(c.snapshot.notice).toEqual({ kind: 'info', text: '200 files added.' });
    await c.addFiles([file]);
    expect(c.snapshot.items).toHaveLength(MAX_BATCH_FILES);
    expect(c.snapshot.notice?.text).toBe('You can add up to 200 files at a time. 1 file was skipped.');
    c.clear();
    expect(c.liveObjectUrls).toBe(0);
  });
});
