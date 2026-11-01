import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';
import { describe, expect, it } from 'vitest';
import { itemKey, type FileItem, type Settings } from '../../src/app/controller';
import { sniff } from '../../src/core/detect';
import { ConversionError } from '../../src/core/errors';
import { getFormat } from '../../src/core/formats';
import { inspectFile } from '../../src/core/inspect';
import { MAX_FILE_BYTES, MAX_MEDIA_BYTES } from '../../src/core/limits';
import { AUDIO_BITRATES, formatDuration, normaliseBitrate } from '../../src/modules/media/bitrate';
import { createMediaConverter } from '../../src/modules/media/converter';
import { checkWavSize, wavBytes } from '../../src/modules/media/run';
import { mp3Frames } from '../fixtures/mp3';
import { clipMkv, clipMov, clipMp4, clipWebm, silentWebm, toneAac, toneFlac, toneM4a, toneMp3, toneOgg } from '../fixtures/media';

/**
 * Audio and video: detection, limits, and real conversions in Node with the
 * same libraries the browser uses (Mediabunny; LAME for MP3). Node has no
 * WebCodecs decoders, so compressed input (Opus, AAC…) is tested in the
 * browser suite; here WAV input exercises the full pipeline, and compressed
 * input exercises the "can't decode" path.
 */

/** A 16-bit PCM WAV with a different sine tone per channel. */
function wav(seconds: number, { rate = 44_100, channels = 2, dataBytes }: { rate?: number; channels?: number; dataBytes?: number } = {}): Uint8Array {
  const frames = Math.round(seconds * rate);
  const size = frames * channels * 2;
  const v = new DataView(new ArrayBuffer(44 + size));
  const tag = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  tag(0, 'RIFF');
  v.setUint32(4, 36 + (dataBytes ?? size), true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  tag(36, 'data');
  v.setUint32(40, dataBytes ?? size, true);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      v.setInt16(44 + (i * channels + c) * 2, Math.round(Math.sin((2 * Math.PI * 440 * (c + 1) * i) / rate) * 12_000), true);
    }
  }
  return new Uint8Array(v.buffer);
}

const converter = createMediaConverter();
const ctx = (signal = new AbortController().signal) => ({ signal, onProgress: () => {} });
const opts = (audioBitrate?: number) => ({ quality: 0.85, background: '#ffffff', audioBitrate });
const convert = (bytes: Uint8Array, name: string, from: string, to: string, kbps?: number, signal?: AbortSignal) =>
  converter.convert({ file: new Blob([bytes as Uint8Array<ArrayBuffer>]), name, format: getFormat(from) }, to, opts(kbps), ctx(signal));

/** Read the result back with Mediabunny: codec, channels, sample rate, duration. */
async function probe(blob: Blob) {
  const input = new Input({ source: new BufferSource(await blob.arrayBuffer()), formats: ALL_FORMATS });
  const track = (await input.getPrimaryAudioTrack())!;
  const info = { codec: track.codec, channels: track.numberOfChannels, rate: track.sampleRate, duration: await input.computeDuration() };
  input.dispose();
  return info;
}

describe('detection of audio and video files from their bytes', () => {
  it.each([
    ['clip.webm', clipWebm, 'webm'],
    ['clip.mkv', clipMkv, 'mkv'],
    ['clip.mp4', clipMp4, 'mp4'],
    ['clip.mov', clipMov, 'mov'],
    ['tone.m4a', toneM4a, 'm4a'],
    ['tone.mp3 (ID3)', toneMp3, 'mp3'],
    ['tone.ogg', toneOgg, 'ogg'],
    ['tone.flac', toneFlac, 'flac'],
    ['tone.aac (ADTS)', toneAac, 'aac'],
    ['tone.wav', wav(0.1), 'wav'],
  ])('%s', (_name, bytes, id) => {
    expect(sniff(bytes.subarray(0, 64)).formatId).toBe(id);
  });

  it('recognises a bare MP3 frame without an ID3 tag, and not random 0xFF bytes', () => {
    expect(sniff(new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0, 0])).formatId).toBe('mp3'); // MPEG-1 L3, 128 kbps, 44.1 kHz
    expect(sniff(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0, 0])).formatId).toBeNull(); // bitrate index 15 is invalid
    expect(sniff(new Uint8Array([0xff, 0xfb, 0x0c, 0x64, 0, 0])).formatId).toBeNull(); // sample-rate index 3 is invalid
  });

  it('still tells HEIC and AVIF (also "ftyp" files) apart from MP4', () => {
    const ftyp = (brand: string) => new Uint8Array([0, 0, 0, 24, ...'ftyp'.split('').map((c) => c.charCodeAt(0)), ...brand.split('').map((c) => c.charCodeAt(0)), 0, 0, 0, 0]);
    expect(sniff(ftyp('heic')).knownUnsupported).toBe('HEIC/HEIF');
    expect(sniff(ftyp('avif')).knownUnsupported).toBe('AVIF');
    expect(sniff(ftyp('isom')).formatId).toBe('mp4');
  });
});

describe('inspecting audio and video files', () => {
  /** A stand-in File of any size whose first bytes are real. */
  const fake = (name: string, size: number, head: Uint8Array, type = '') =>
    ({ name, size, type, slice: () => new Blob([head as Uint8Array<ArrayBuffer>]) }) as unknown as File;

  it('accepts videos larger than the 100 MB image limit, up to 2 GB', async () => {
    const info = await inspectFile(fake('holiday.mp4', MAX_FILE_BYTES * 5, clipMp4.subarray(0, 64)));
    expect(info.format.id).toBe('mp4');
    expect(info.format.category).toBe('video');
    await expect(inspectFile(fake('huge.mp4', MAX_MEDIA_BYTES + 1, clipMp4.subarray(0, 64)))).rejects.toThrow(/Audio and video files can be up to 2(\.0)? GB/);
  });

  it('keeps the 100 MB limit for anything that turns out not to be audio or video', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 4, 0, 0, 0, 4]);
    await expect(inspectFile(fake('fake.mp4', MAX_FILE_BYTES + 1, png))).rejects.toThrow(/The limit is 100 MB per file/);
    await expect(inspectFile(fake('big.png', MAX_FILE_BYTES + 1, png))).rejects.toThrow(/The limit is 100 MB per file/);
  });

  it('warns when the name is misleading, but not between members of one container family', async () => {
    const renamed = await inspectFile(new File([clipWebm as Uint8Array<ArrayBuffer>], 'song.mp3'));
    expect(renamed.format.id).toBe('webm');
    expect(renamed.warnings[0]).toMatch(/named \.mp3 but is actually a WebM file/);
    const m4aAsMp4 = await inspectFile(new File([toneM4a as Uint8Array<ArrayBuffer>], 'tone.mp4'));
    expect(m4aAsMp4.warnings).toEqual([]);
  });
});

describe('MP3 output', () => {
  it('uses exactly the chosen bitrate, and the file size follows it', async () => {
    const input = wav(3);
    const sizes: Record<number, number> = {};
    for (const kbps of [64, 128, 320]) {
      const r = await convert(input, 'tone.wav', 'wav', 'mp3', kbps);
      const bytes = new Uint8Array(await r.blob.arrayBuffer());
      expect(sniff(bytes).formatId).toBe('mp3');
      const { frames } = mp3Frames(bytes);
      expect(frames.length).toBeGreaterThan(100); // ~38 frames per second
      expect(new Set(frames.map((f) => f.kbps))).toEqual(new Set([kbps])); // constant bitrate, every frame
      // Constant bitrate: 3 s at N kbit/s is about 3·N/8 KB.
      expect(bytes.length).toBeGreaterThan(((3 * kbps * 1000) / 8) * 0.9);
      expect(bytes.length).toBeLessThan(((3 * kbps * 1000) / 8) * 1.15);
      expect(r.fileName).toBe('tone.mp3');
      expect(r.label).toBe(`MP3 · ${kbps} kbps`);
      expect(r.blob.type).toBe('audio/mpeg');
      sizes[kbps] = bytes.length;
    }
    expect(sizes[128]! / sizes[64]!).toBeCloseTo(2, 0);
  });

  it('keeps the length, stereo channels and sample rate', async () => {
    const r = await convert(wav(2, { rate: 44_100 }), 'a.wav', 'wav', 'mp3', 128);
    const info = await probe(r.blob);
    expect(info.codec).toBe('mp3');
    expect(info.channels).toBe(2);
    expect(info.rate).toBe(44_100);
    expect(info.duration).toBeGreaterThan(1.95);
    expect(info.duration).toBeLessThan(2.1);
  });

  it('mixes surround sound down to stereo and says so', async () => {
    const r = await convert(wav(1, { channels: 6 }), 'surround.wav', 'wav', 'mp3', 192);
    expect((await probe(r.blob)).channels).toBe(2);
    expect(r.warnings.join(' ')).toMatch(/6-channel sound was mixed down to stereo/);
  });

  it('resamples audio above 48 kHz, which MP3 cannot store', async () => {
    const r = await convert(wav(1, { rate: 96_000 }), 'hires.wav', 'wav', 'mp3', 256);
    const bytes = new Uint8Array(await r.blob.arrayBuffer());
    expect(new Set(mp3Frames(bytes).frames.map((f) => f.rate))).toEqual(new Set([48_000]));
  });
});

describe('WAV output', () => {
  it('copies PCM audio sample for sample', async () => {
    const input = wav(0.5, { rate: 22_050 });
    const r = await convert(input, 'a.wav', 'wav', 'wav');
    const out = new Uint8Array(await r.blob.arrayBuffer());
    expect(sniff(out).formatId).toBe('wav');
    // The samples after the header are identical.
    const pcm = (b: Uint8Array) => {
      let o = 12;
      while (String.fromCharCode(...b.subarray(o, o + 4)) !== 'data') o += 8 + new DataView(b.buffer, b.byteOffset).getUint32(o + 4, true);
      return b.subarray(o + 8);
    };
    expect(pcm(out).length).toBe(pcm(input).length);
    expect(Buffer.compare(Buffer.from(pcm(out)), Buffer.from(pcm(input)))).toBe(0);
    expect(r.warnings).toEqual([]);
  });

  it('estimates WAV size from the length, and refuses more than 1 GB, suggesting MP3', () => {
    // 10 minutes of 48 kHz stereo is about 110 MB; 2 hours is about 1.3 GB.
    expect(wavBytes(600, 48_000, 2)).toBe(600 * 48_000 * 2 * 2 + 44);
    expect(() => checkWavSize(600, 48_000, 2)).not.toThrow();
    expect(() => checkWavSize(7200, 48_000, 2)).toThrow(/2:00:00 of audio would be about 1\.\d GB, over the 1(\.0)? GB limit\. Choose MP3 instead/);
  });
});

describe('problems are explained', () => {
  it('a video with no sound track', async () => {
    await expect(convert(silentWebm, 'silent.webm', 'webm', 'mp3', 128)).rejects.toThrow("This video has no sound track, so there's no audio to save.");
  });

  it('a codec this environment cannot decode names the codec and what to do', async () => {
    // Node has no WebCodecs, so Opus can't be decoded here (browsers can).
    const err = await convert(clipWebm, 'clip.webm', 'webm', 'mp3', 128).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConversionError);
    expect((err as Error).message).toMatch(/can't decode the Opus audio in this file\. Try an up-to-date Chrome, Edge or Firefox, or Safari 26 or newer/);
  });

  it('a damaged file', async () => {
    const broken = clipMp4.slice(0, 200);
    await expect(convert(broken, 'broken.mp4', 'mp4', 'mp3', 128)).rejects.toThrow(ConversionError);
  });

  it('cancelling stops the conversion', async () => {
    const ctrl = new AbortController();
    const pending = convert(wav(30), 'long.wav', 'wav', 'mp3', 128, ctrl.signal);
    ctrl.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

describe('what the converter offers', () => {
  it('MP3 and WAV for every audio and video input; videos say "sound only"', () => {
    for (const id of ['mp4', 'mov', 'webm', 'mkv', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac']) expect(converter.outputsFor(id)).toEqual(['mp3', 'wav']);
    expect(converter.outputsFor('png')).toEqual([]);
    expect(converter.outputLabel!('mp4', 'mp3')).toBe('MP3 (sound only)');
    expect(converter.outputLabel!('ogg', 'mp3')).toBeUndefined();
  });

  it('offers nothing, with a reason, in the standalone file', () => {
    const offline = createMediaConverter({ available: false });
    expect(offline.outputsFor('mp4')).toEqual([]);
    expect(offline.unavailableReason!('mp4')).toMatch(/needs the OpenConverter website/);
  });

  it('bitrates snap to the offered choices', () => {
    expect([...AUDIO_BITRATES]).toEqual([320, 256, 192, 128, 96, 64]);
    expect(normaliseBitrate(128)).toBe(128);
    expect(normaliseBitrate(100)).toBe(96);
    expect(normaliseBitrate(1000)).toBe(320);
    expect(normaliseBitrate(undefined)).toBe(128);
    expect(normaliseBitrate(NaN)).toBe(128);
    expect(formatDuration(5)).toBe('0:05');
    expect(formatDuration(3725)).toBe('1:02:05');
  });

  it('an MP3 result goes out of date when the bitrate changes; a WAV result does not', () => {
    const settings = { target: 'webp', quality: 0.85, background: '#fff', audioBitrate: 128 } as Settings;
    const item = (target: string) => ({ format: getFormat('mp4'), target }) as FileItem;
    expect(itemKey(item('mp3'), settings)).not.toBe(itemKey(item('mp3'), { ...settings, audioBitrate: 64 }));
    expect(itemKey(item('wav'), settings)).toBe(itemKey(item('wav'), { ...settings, audioBitrate: 64 }));
  });
});
