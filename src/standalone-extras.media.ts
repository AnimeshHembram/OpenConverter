/**
 * Standalone build only (see vite.config.ts): a page opened from disk can't
 * load scripts on demand, so the audio and video conversion code is bundled
 * into the single index.html and handed to the media converter directly.
 */
import type { InlinedMedia } from './modules/media/converter';
import * as run from './modules/media/run';

export const inlinedMedia: InlinedMedia | undefined = { run };
