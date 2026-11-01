/**
 * Website build: nothing extra. Audio and video libraries load on demand.
 *
 * The standalone build (scripts/build-standalone.mjs) swaps this module for
 * standalone-extras.media.ts, which bundles them into the single file.
 */
import type { InlinedMedia } from './modules/media/converter';

export const inlinedMedia: InlinedMedia | undefined = undefined;
