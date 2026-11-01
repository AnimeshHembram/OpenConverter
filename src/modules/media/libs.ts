/**
 * Where the audio libraries come from. On the website they load on first use
 * as separate files. The standalone build swaps this module for
 * libs.standalone.ts (see vite.config.ts), which has them built in: an
 * on-demand import of a library that's already in the page would keep every
 * part of it, not just the parts used.
 */
import type { Libraries } from './run';

export const loadLibraries = async (): Promise<Libraries> => ({ mb: await import('mediabunny') });

/** LAME (MP3 encoder), only needed when the browser can't encode MP3 itself. */
export const loadMp3Encoder = async (): Promise<() => void> => (await import('@mediabunny/mp3-encoder')).registerMp3Encoder;
