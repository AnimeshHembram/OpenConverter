/**
 * Standalone build only (see libs.ts and vite.config.ts): the audio libraries
 * are part of the single index.html. Only the parts used are imported.
 */
import { registerMp3Encoder } from '@mediabunny/mp3-encoder';
import { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Mp3OutputFormat, Output, WavOutputFormat, canEncodeAudio } from 'mediabunny';
import type { Libraries } from './run';

const mb = { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Mp3OutputFormat, Output, WavOutputFormat, canEncodeAudio };

export const loadLibraries = async (): Promise<Libraries> => ({ mb, registerMp3: registerMp3Encoder });

export const loadMp3Encoder = async (): Promise<() => void> => registerMp3Encoder;
