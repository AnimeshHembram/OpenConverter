/**
 * Person segmentation for background removal: Google's MediaPipe selfie
 * segmentation model (Apache-2.0), run by OpenConverter's own small
 * interpreter (tflite.ts). The ~250 KB model file is served by this site and
 * downloaded once, the first time a photo needs it. The photo itself never
 * leaves the device.
 */
import { ConversionError } from '../../core/errors';
import { cleanProbabilities, modelInput, refineMatte, type PersonMask } from './matte';
import { loadTflite, type TfliteModel } from './tflite';

/** SHA-256 of selfie_segmentation.tflite from @mediapipe/selfie_segmentation 0.1.1675465747. */
export const MODEL_SHA256 = '8d13b7fae74af625c641226813616a2117bd6bca19eb3b75574621fc08557f27';
export const MODEL_PATH = 'assets/models/selfie_segmentation.tflite';

export interface PersonSegmentation extends PersonMask {
  /** Full-resolution alpha, one byte per pixel, aligned with the input. */
  alpha: Uint8Array;
}

export interface Segmenter {
  /** Find people in `rgba` and return a refined matte. */
  segment(rgba: Uint8ClampedArray, width: number, height: number): Promise<PersonSegmentation>;
}

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

/** Yield to the browser so progress labels can paint between heavy steps. */
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Segmentation from already-loaded model bytes (used directly by tests). */
export function segmenterFromModel(model: TfliteModel): Segmenter {
  return {
    async segment(rgba, width, height) {
      const prob = model.run(modelInput(rgba, width, height));
      await tick();
      const mask = cleanProbabilities(prob);
      const alpha = refineMatte(mask.prob, rgba, width, height);
      return { ...mask, alpha };
    },
  };
}

/**
 * A segmenter that fetches and checks the model on first use. A failed
 * download can be retried; a file that doesn't match the expected checksum
 * is never run.
 */
export function createSegmenter(url = `${import.meta.env.BASE_URL}${MODEL_PATH}`): Segmenter {
  let loading: Promise<Segmenter> | null = null;
  const load = () =>
    (loading ??= (async () => {
      let bytes: ArrayBuffer;
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        bytes = await res.arrayBuffer();
      } catch (e) {
        throw new ConversionError(
          'ENCODER_LOAD_FAILED',
          "OpenConverter's background-removal model couldn't be loaded. Check your internet connection and try again.",
          { cause: e },
        );
      }
      if (crypto?.subtle) {
        const digest = hex(await crypto.subtle.digest('SHA-256', bytes));
        if (digest !== MODEL_SHA256) {
          throw new ConversionError('ENCODER_LOAD_FAILED', "OpenConverter's background-removal model file is damaged, so it wasn't used. Reload the page and try again.");
        }
      }
      try {
        return segmenterFromModel(loadTflite(new Uint8Array(bytes)));
      } catch (e) {
        throw new ConversionError('ENCODER_LOAD_FAILED', "OpenConverter's background-removal model couldn't be started in this browser.", { cause: e });
      }
    })().catch((e) => {
      loading = null; // allow a retry
      throw e;
    }));
  return {
    async segment(rgba, width, height) {
      return (await load()).segment(rgba, width, height);
    },
  };
}
