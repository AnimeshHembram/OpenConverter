/**
 * Audio and video → MP3 or WAV, entirely on the device.
 *
 * Mediabunny (MPL-2.0) reads the file in small pieces (MP4/MOV/M4A, WebM/MKV,
 * Ogg, MP3, WAV, FLAC, AAC), decodes the sound with the browser's own
 * decoders (WebCodecs) and writes the new file. Video is never decoded: the
 * picture is simply left out. MP3 is encoded with LAME compiled to
 * WebAssembly (@mediabunny/mp3-encoder), loaded only when MP3 is chosen and
 * the browser has no MP3 encoder of its own.
 *
 * This file only describes what can be converted; the conversion code and
 * the libraries (run.ts) load on first use.
 */
import { FORMATS, getFormat } from '../../core/formats';
import type { Converter } from '../../core/types';
import type { Libraries } from './run';

export { AUDIO_BITRATES, DEFAULT_AUDIO_BITRATE, formatDuration, normaliseBitrate } from './bitrate';

const MEDIA_INPUTS = FORMATS.filter((f) => f.category === 'audio' || f.category === 'video').map((f) => f.id);
const OUTPUTS = ['mp3', 'wav'];

export interface MediaConverterOptions {
  /** False when the libraries can't load, e.g. in the standalone file opened from disk. */
  available?: boolean;
  /** For tests: how to load the libraries. */
  load?: () => Promise<Libraries>;
}

export function createMediaConverter(opts: MediaConverterOptions = {}): Converter {
  const available = opts.available ?? true;
  return {
    id: 'media',
    category: 'audio',

    outputsFor(fromId) {
      return available && MEDIA_INPUTS.includes(fromId) ? OUTPUTS : [];
    },

    outputLabel(fromId, toId) {
      if (getFormat(fromId).category !== 'video') return undefined;
      return toId === 'mp3' ? 'MP3 (sound only)' : 'WAV (sound only)';
    },

    unavailableReason(fromId) {
      if (available || !MEDIA_INPUTS.includes(fromId)) return undefined;
      return "Audio and video conversion needs the OpenConverter website: it loads its audio tools from there, which a page opened from disk can't do.";
    },

    async convert(input, toId, options, ctx) {
      const { convertMedia } = await import('./run');
      return convertMedia(input, toId, options, ctx, opts.load);
    },
  };
}
