import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sniff } from '../../src/core/detect';
import { clipMp4, clipWebm, CLIP_SECONDS, silentWebm, toneFlac, toneMp3, toneOgg, TONES } from '../fixtures/media';
import { mp3Frames } from '../fixtures/mp3';
import { addFiles, open } from './helpers';

/**
 * Video → audio and audio conversion in the real app. Outputs are decoded by
 * the browser and checked: length, channel count, and that the left channel
 * still carries the 440 Hz tone and the right the 880 Hz one. MP3 bitrates
 * are read from every frame of the file.
 */

const card = (page: Page, name: string) => page.getByTestId('file-card').filter({ hasText: name });
const file = (name: string, bytes: Uint8Array, mimeType: string) => ({ name, mimeType, buffer: Buffer.from(bytes) });

async function convertRow(page: Page, name: string, target?: string) {
  const row = card(page, name);
  if (target) await row.getByTestId('row-target').selectOption(target);
  await page.getByTestId('convert').click();
  await expect(row).toHaveAttribute('data-status', /done|error/, { timeout: 60_000 });
  await expect(row, await row.innerText()).toHaveAttribute('data-status', 'done');
  const [download] = await Promise.all([page.waitForEvent('download'), row.getByTestId('download').click()]);
  return { name: download.suggestedFilename(), bytes: await readFile((await download.path())!), row };
}

/** Decode audio in the page; return its length, channels and each channel's main frequency. */
async function listen(page: Page, bytes: Buffer) {
  return page.evaluate(async (b64) => {
    const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const ctx = new OfflineAudioContext(1, 1, 48_000);
    const audio = await ctx.decodeAudioData(data.buffer);
    // Frequency from zero crossings in the middle second (away from encoder padding).
    const freq = (ch: Float32Array) => {
      const from = Math.floor(audio.sampleRate * 0.5);
      const to = Math.min(ch.length, from + audio.sampleRate);
      let crossings = 0;
      for (let i = from + 1; i < to; i++) if ((ch[i - 1]! < 0) !== (ch[i]! < 0)) crossings++;
      return crossings / 2 / ((to - from) / audio.sampleRate);
    };
    return {
      duration: audio.duration,
      channels: audio.numberOfChannels,
      freqs: Array.from({ length: audio.numberOfChannels }, (_, c) => freq(audio.getChannelData(c))),
    };
  }, bytes.toString('base64'));
}

function expectTones(heard: { duration: number; channels: number; freqs: number[] }) {
  expect(heard.channels).toBe(2);
  expect(heard.duration).toBeGreaterThan(CLIP_SECONDS - 0.1);
  expect(heard.duration).toBeLessThan(CLIP_SECONDS + 0.15);
  expect(Math.abs(heard.freqs[0]! - TONES.left)).toBeLessThan(TONES.left * 0.03);
  expect(Math.abs(heard.freqs[1]! - TONES.right)).toBeLessThan(TONES.right * 0.03);
}

test.describe('audio and video', () => {
  test.slow();

  test("a video's sound is saved as MP3 at the chosen bitrate, and the bitrate can be changed", async ({ page }) => {
    const errors = await open(page);
    const outside: string[] = [];
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (['http:', 'https:'].includes(u.protocol) && u.host !== 'localhost:4173') outside.push(r.url());
    });
    await addFiles(page, [file('holiday.webm', clipWebm, 'video/webm')]);
    const row = card(page, 'holiday.webm');
    await expect(row).toContainText('WebM');
    expect(await row.getByTestId('row-target').locator('option').allTextContents()).toEqual(['MP3 (sound only)', 'WAV (sound only)']);
    // MP3 is the default, so the bitrate choice shows; image settings don't.
    await expect(page.getByTestId('audio-settings')).toBeVisible();
    await expect(page.getByTestId('target')).toBeHidden();
    await expect(page.getByTestId('audio-bitrate')).toHaveValue('128');
    await page.getByTestId('audio-bitrate').selectOption('64');

    const low = await convertRow(page, 'holiday.webm');
    expect(low.name).toBe('holiday.mp3');
    expect(sniff(low.bytes).formatId).toBe('mp3');
    expect(new Set(mp3Frames(low.bytes).frames.map((f) => f.kbps))).toEqual(new Set([64]));
    await expect(low.row.getByTestId('status')).toContainText('Converted to MP3 · 64 kbps');
    expectTones(await listen(page, low.bytes));

    // Changing the bitrate marks the result out of date; converting again applies it.
    await page.getByTestId('audio-bitrate').selectOption('192');
    await expect(low.row.getByTestId('status')).toContainText('convert again');
    const high = await convertRow(page, 'holiday.webm');
    expect(new Set(mp3Frames(high.bytes).frames.map((f) => f.kbps))).toEqual(new Set([192]));
    expect(high.bytes.length / low.bytes.length).toBeGreaterThan(2.5); // 192 vs 64 kbps
    expectTones(await listen(page, high.bytes));

    expect(outside).toEqual([]);
    expect(errors).toEqual([]); // includes Content-Security-Policy violations (the MP3 encoder's worker)
  });

  test("a video's sound saved as WAV; the bitrate choice is hidden because WAV has none", async ({ page }) => {
    await open(page);
    await addFiles(page, [file('clip.webm', clipWebm, 'video/webm')]);
    await card(page, 'clip.webm').getByTestId('row-target').selectOption('wav');
    await expect(page.getByTestId('audio-settings')).toBeHidden();
    const wav = await convertRow(page, 'clip.webm');
    expect(wav.name).toBe('clip.wav');
    expect(sniff(wav.bytes).formatId).toBe('wav');
    expectTones(await listen(page, wav.bytes));
    await expect(wav.row).toContainText("WAV is uncompressed: the file is much larger, but the sound isn't any better");
  });

  test('audio files convert too: MP3 → WAV, Ogg Vorbis → MP3, FLAC → MP3', async ({ page }) => {
    await open(page);
    await addFiles(page, [file('a.mp3', toneMp3, 'audio/mpeg'), file('b.ogg', toneOgg, 'audio/ogg'), file('c.flac', toneFlac, 'audio/flac')]);
    expect(await card(page, 'a.mp3').getByTestId('row-target').locator('option').allTextContents()).toEqual(['MP3', 'WAV']);
    // One click converts the whole batch, each file to its own choice.
    await card(page, 'a.mp3').getByTestId('row-target').selectOption('wav');
    await page.getByTestId('convert').click();
    for (const name of ['a.mp3', 'b.ogg', 'c.flac']) {
      await expect(card(page, name), name).toHaveAttribute('data-status', 'done', { timeout: 60_000 });
    }
    const download = async (name: string) => {
      const [d] = await Promise.all([page.waitForEvent('download'), card(page, name).getByTestId('download').click()]);
      return readFile((await d.path())!);
    };
    const wav = await download('a.mp3');
    expect(sniff(wav).formatId).toBe('wav');
    expectTones(await listen(page, wav));
    for (const name of ['b.ogg', 'c.flac']) {
      const mp3 = await download(name);
      expect(sniff(mp3).formatId).toBe('mp3');
      expect(new Set(mp3Frames(mp3).frames.map((f) => f.kbps))).toEqual(new Set([128]));
      expectTones(await listen(page, mp3));
    }
  });

  test('MP4 with AAC sound: converted where the browser can decode AAC, otherwise explained', async ({ page }) => {
    await open(page);
    // Builds of Chromium without proprietary codecs can't decode AAC; branded
    // browsers can. Ask this browser rather than assume by name.
    const aac = await page.evaluate(async () => {
      if (typeof AudioDecoder === 'undefined') return false;
      try {
        return !!(await AudioDecoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 48_000, numberOfChannels: 2 })).supported;
      } catch {
        return false;
      }
    });
    await addFiles(page, [file('phone.mp4', clipMp4, 'video/mp4')]);
    const row = card(page, 'phone.mp4');
    await page.getByTestId('convert').click();
    await expect(row).toHaveAttribute('data-status', /done|error/, { timeout: 60_000 });
    if (aac) {
      await expect(row).toHaveAttribute('data-status', 'done');
      const [download] = await Promise.all([page.waitForEvent('download'), row.getByTestId('download').click()]);
      const bytes = await readFile((await download.path())!);
      expect(sniff(bytes).formatId).toBe('mp3');
      expectTones(await listen(page, bytes));
    } else {
      await expect(row).toHaveAttribute('data-status', 'error');
      await expect(row).toContainText("This browser can't decode the AAC audio in this file");
    }
  });

  test('a video without a sound track gets a clear explanation', async ({ page }) => {
    await open(page);
    await addFiles(page, [file('silent.webm', silentWebm, 'video/webm')]);
    await page.getByTestId('convert').click();
    const row = card(page, 'silent.webm');
    await expect(row).toHaveAttribute('data-status', 'error', { timeout: 60_000 });
    await expect(row).toContainText("This video has no sound track, so there's no audio to save.");
    await expect(row.getByTestId('download')).toBeHidden();
  });

  test('the preview plays the video and the converted audio', async ({ page }) => {
    await open(page);
    await addFiles(page, [file('clip.webm', clipWebm, 'video/webm')]);
    await convertRow(page, 'clip.webm');
    await card(page, 'clip.webm').getByRole('button', { name: /preview/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('video[controls]')).toHaveCount(1);
    await expect(dialog.locator('audio[controls]')).toHaveCount(1);
    expect(await dialog.locator('audio').getAttribute('src')).toMatch(/^blob:/);
  });
});

// The standalone file has the audio tools built in, so it converts audio
// and video straight from disk, with the same checks as the website.
test('the standalone file, opened from disk, converts a video to MP3 at the chosen bitrate and to WAV', async ({ page }) => {
  test.slow();
  const errors: string[] = [];
  const requests: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(pathToFileURL(resolve('dist-standalone/index.html')).href);
  await expect(page.locator('#app')).not.toHaveAttribute('aria-busy');
  await addFiles(page, [file('clip.webm', clipWebm, 'video/webm'), file('tone.ogg', toneOgg, 'audio/ogg')]);
  await page.getByTestId('audio-bitrate').selectOption('96');
  await card(page, 'tone.ogg').getByTestId('row-target').selectOption('wav');
  await page.getByTestId('convert').click();
  for (const name of ['clip.webm', 'tone.ogg']) {
    await expect(card(page, name), name).toHaveAttribute('data-status', 'done', { timeout: 60_000 });
  }
  const download = async (name: string) => {
    const [d] = await Promise.all([page.waitForEvent('download'), card(page, name).getByTestId('download').click()]);
    return { name: d.suggestedFilename(), bytes: await readFile((await d.path())!) };
  };
  const mp3 = await download('clip.webm');
  expect(mp3.name).toBe('clip.mp3');
  expect(new Set(mp3Frames(mp3.bytes).frames.map((f) => f.kbps))).toEqual(new Set([96]));
  expectTones(await listen(page, mp3.bytes));
  const wav = await download('tone.ogg');
  expect(sniff(wav.bytes).formatId).toBe('wav');
  expectTones(await listen(page, wav.bytes));
  // Nothing was fetched: everything, including the MP3 encoder, is in the page.
  expect(requests.filter((u) => /^https?:/.test(u))).toEqual([]);
  expect(errors).toEqual([]);
});
