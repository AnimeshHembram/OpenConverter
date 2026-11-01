/**
 * The conversion itself, loaded only when an audio or video file is
 * converted (see converter.ts for what this does and why).
 */
import { ConversionError, throwIfAborted } from '../../core/errors';
import { sniff } from '../../core/detect';
import { outputFileName } from '../../core/filename';
import { getFormat } from '../../core/formats';
import { MAX_WAV_OUTPUT_BYTES, formatBytes } from '../../core/limits';
import type { ConversionContext, ConversionInput, ConversionResult, ConvertOptions } from '../../core/types';
import { formatDuration, normaliseBitrate } from './bitrate';
import { loadLibraries, loadMp3Encoder } from './libs';

/** The parts of Mediabunny this converter uses. */
export type Mediabunny = Pick<
  typeof import('mediabunny'),
  'ALL_FORMATS' | 'BlobSource' | 'BufferTarget' | 'Conversion' | 'Input' | 'Mp3OutputFormat' | 'Output' | 'WavOutputFormat' | 'canEncodeAudio'
>;

export interface Libraries {
  mb: Mediabunny;
  registerMp3?: () => void;
}

const OUTPUTS = ['mp3', 'wav'];
/** MP3 (MPEG-1 Layer III) can't store more than this sample rate or two channels. */
const MP3_MAX_RATE = 48_000;

/** Size of a 16-bit PCM WAV file. */
export const wavBytes = (seconds: number, rate: number, channels: number) => Math.round(seconds * rate) * channels * 2 + 44;

/** WAV is uncompressed, so long audio is refused before converting. */
export function checkWavSize(seconds: number, rate: number, channels: number): void {
  const estimate = wavBytes(seconds, rate, channels);
  if (estimate > MAX_WAV_OUTPUT_BYTES) {
    throw new ConversionError(
      'FILE_TOO_LARGE',
      `As WAV, ${formatDuration(seconds)} of audio would be about ${formatBytes(estimate)}, over the ${formatBytes(MAX_WAV_OUTPUT_BYTES)} limit. Choose MP3 instead.`,
    );
  }
}

let libs: Promise<Libraries> | null = null;
const defaultLoad = (): Promise<Libraries> =>
  (libs ??= loadLibraries().catch((e) => {
    libs = null;
    throw e;
  }));

let mp3Ready: Promise<void> | null = null;
/** Use the browser's MP3 encoder if it has one, otherwise register LAME. */
function ensureMp3Encoder(mb: Mediabunny, registerMp3?: () => void): Promise<void> {
  return (mp3Ready ??= (async () => {
    if (await mb.canEncodeAudio('mp3')) return;
    (registerMp3 ?? (await loadMp3Encoder()))();
  })().catch((e) => {
    mp3Ready = null;
    throw e;
  }));
}

const CODEC_NAMES: Record<string, string> = {
  aac: 'AAC',
  opus: 'Opus',
  vorbis: 'Vorbis',
  mp3: 'MP3',
  flac: 'FLAC',
  ac3: 'Dolby Digital (AC-3)',
  eac3: 'Dolby Digital Plus (E-AC-3)',
  alac: 'Apple Lossless',
};

export async function convertMedia(
  input: ConversionInput,
  toId: string,
  options: ConvertOptions,
  ctx: ConversionContext,
  load: () => Promise<Libraries> = defaultLoad,
): Promise<ConversionResult> {
  const target = getFormat(toId);
  if (!OUTPUTS.includes(toId)) throw new ConversionError('ENCODE_UNSUPPORTED', `Audio can't be saved as ${target.label}.`);
  const fromVideo = input.format.category === 'video';
  ctx.onProgress({ fraction: 0.02, stage: 'Loading audio tools' });

  let lib: Libraries;
  try {
    lib = await load();
    if (toId === 'mp3') await ensureMp3Encoder(lib.mb, lib.registerMp3);
  } catch (e) {
    throw new ConversionError('ENCODER_LOAD_FAILED', "OpenConverter's audio tools couldn't be loaded. Check your internet connection and try again.", { cause: e });
  }
  const { mb } = lib;
  throwIfAborted(ctx.signal);
  ctx.onProgress({ fraction: 0.05, stage: 'Reading' });

  const media = new mb.Input({ source: new mb.BlobSource(input.file), formats: mb.ALL_FORMATS });
  try {
    let track: Awaited<ReturnType<typeof media.getPrimaryAudioTrack>>;
    try {
      track = await media.getPrimaryAudioTrack();
    } catch (e) {
      throw new ConversionError('DECODE_FAILED', `This ${input.format.label} file couldn't be read. It may be damaged or incomplete.`, { cause: e });
    }
    if (!track) {
      throw new ConversionError(
        'DECODE_FAILED',
        fromVideo ? "This video has no sound track, so there's no audio to save." : 'No audio was found in this file.',
      );
    }
    const codec = track.codec;
    const codecName = (codec && (CODEC_NAMES[codec] ?? (codec.startsWith('pcm') ? 'PCM' : codec.toUpperCase()))) || 'unknown';
    if (!codec || !(await track.canDecode())) {
      throw new ConversionError(
        'DECODE_FAILED',
        `This browser can't decode the ${codecName} audio in this file. Try an up-to-date Chrome, Edge or Firefox, or Safari 26 or newer.`,
      );
    }
    const duration = await media.computeDuration([track]);
    const channels = track.numberOfChannels;
    const rate = track.sampleRate;
    const warnings: string[] = [];
    if (!(duration > 0)) throw new ConversionError('DECODE_FAILED', 'This file has no audio to convert (its length is zero).');

    const kbps = normaliseBitrate(options.audioBitrate);
    let audio: import('mediabunny').ConversionAudioOptions;
    if (toId === 'mp3') {
      // Always re-encode, so the chosen bitrate applies even to MP3 input.
      audio = { codec: 'mp3', bitrate: kbps * 1000, forceTranscode: true };
      if (channels > 2) {
        audio.numberOfChannels = 2;
        warnings.push(`The ${channels}-channel sound was mixed down to stereo, because MP3 holds at most two channels.`);
      }
      if (rate > MP3_MAX_RATE) audio.sampleRate = MP3_MAX_RATE;
    } else {
      checkWavSize(duration, rate, channels);
    audio = { codec: 'pcm-s16' };
    }

    const output = new mb.Output({
      format: toId === 'mp3' ? new mb.Mp3OutputFormat() : new mb.WavOutputFormat(),
      target: new mb.BufferTarget(),
    });
    const conversion = await mb.Conversion.init({ input: media, output, tracks: 'primary', video: { discard: true }, audio });
    const used = conversion.utilizedTracks.some((t) => t.type === 'audio');
    if (!conversion.isValid || !used) {
      const reason = conversion.discardedTracks.find((d) => d.track.type === 'audio')?.reason;
      throw new ConversionError(
        reason === 'no_encodable_target_codec' ? 'ENCODE_UNSUPPORTED' : 'DECODE_FAILED',
        reason === 'no_encodable_target_codec'
          ? `This browser can't create ${target.label} audio from this file. Try ${toId === 'mp3' ? 'WAV' : 'MP3'} instead.`
          : `This browser can't decode the ${codecName} audio in this file. Try an up-to-date Chrome, Edge or Firefox, or Safari 26 or newer.`,
      );
    }

    const stop = () => void conversion.cancel();
    ctx.signal.addEventListener('abort', stop, { once: true });
    conversion.onProgress = (p) => ctx.onProgress({ fraction: 0.08 + 0.85 * p, stage: fromVideo ? 'Extracting audio' : 'Converting audio' });
    try {
      await conversion.execute();
    } catch (e) {
      throwIfAborted(ctx.signal);
      throw new ConversionError('ENCODE_FAILED', `The audio couldn't be converted to ${target.label}. The file may be damaged, or this device ran out of memory.`, { cause: e });
    } finally {
      ctx.signal.removeEventListener('abort', stop);
    }
    throwIfAborted(ctx.signal);

    ctx.onProgress({ fraction: 0.95, stage: 'Checking' });
    const buffer = (output.target as import('mediabunny').BufferTarget).buffer;
    if (!buffer || buffer.byteLength === 0 || sniff(new Uint8Array(buffer, 0, Math.min(64, buffer.byteLength))).formatId !== toId) {
      throw new ConversionError('ENCODE_FAILED', `The ${target.label} file came out empty or damaged, so it was not saved. Try again or choose another format.`);
    }
    if (input.format.lossy && toId === 'wav') warnings.push("WAV is uncompressed: the file is much larger, but the sound isn't any better than the original.");
    ctx.onProgress({ fraction: 1, stage: 'Done' });
    return {
      blob: new Blob([buffer], { type: target.mime }),
      format: target,
      fileName: outputFileName(input.name, target.extensions[0]!),
      label: toId === 'mp3' ? `MP3 · ${kbps} kbps` : 'WAV',
      warnings,
    };
  } finally {
    media.dispose?.();
  }
}
