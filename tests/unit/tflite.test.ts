import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { modelInput } from '../../src/modules/image/matte';
import { MODEL_SHA256 } from '../../src/modules/image/segment';
import { loadTflite, ModelError } from '../../src/modules/image/tflite';
import { rainyStreet } from '../fixtures/scenes';

const require = createRequire(import.meta.url);
const modelFile = join(dirname(require.resolve('@mediapipe/selfie_segmentation/package.json')), 'selfie_segmentation.tflite');
const bytes = new Uint8Array(readFileSync(modelFile));

/**
 * Reference values from Google's own interpreter (LiteRT, ai-edge-litert
 * 2.x) for the same input: the rainy-street scene at 256 × 320, squashed to
 * the model's 256 × 256 input by modelInput(). GOLDEN holds the mean output
 * of each 16 × 16 block, row by row; POINTS holds single outputs [y, x, value].
 */
const GOLDEN = [0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0489, 0.0568, 0.0005, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.6029, 0.9651, 0.2569, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0646, 0.6983, 0.9883, 0.2736, 0.0114, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0092, 0.7337, 0.9550, 0.9968, 0.8732, 0.2965, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0461, 0.9763, 1.0000, 1.0000, 1.0000, 0.5021, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.1779, 0.9983, 1.0000, 1.0000, 1.0000, 0.6157, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.2202, 0.9969, 1.0000, 1.0000, 0.9960, 0.6631, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.2145, 0.9280, 1.0000, 1.0000, 1.0000, 0.6851, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.3117, 0.6395, 0.9326, 0.9999, 0.9918, 0.3323, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.2779, 0.6563, 0.7058, 0.9735, 0.9441, 0.1107, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0592, 0.3829, 0.6698, 0.9160, 0.9998, 0.9260, 0.0211, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.1044, 0.3581, 0.5878, 0.9101, 0.9204, 0.8663, 0.0350, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0831, 0.2560, 0.4304, 0.6038, 0.6548, 0.5247, 0.0194, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000];
const POINTS: [number, number, number][] = [[128, 128, 1.0], [60, 128, 0.0975], [200, 128, 0.7319], [240, 100, 0.4483], [10, 10, 0], [30, 220, 0]];

describe('TFLite interpreter', () => {
  it('ships the exact model file the app checks for', () => {
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(MODEL_SHA256);
  });

  it('matches the reference interpreter on the selfie segmentation model', () => {
    const model = loadTflite(bytes);
    expect(model.inputShape).toEqual([1, 256, 256, 3]);
    expect(model.outputShape).toEqual([1, 256, 256, 1]);
    const scene = rainyStreet(256, 320);
    const out = model.run(modelInput(scene.rgba, scene.width, scene.height));
    expect(out.length).toBe(256 * 256);
    for (let by = 0; by < 16; by++) {
      for (let bx = 0; bx < 16; bx++) {
        let s = 0;
        for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) s += out[(by * 16 + y) * 256 + bx * 16 + x]!;
        expect(Math.abs(s / 256 - GOLDEN[by * 16 + bx]!)).toBeLessThan(0.002);
      }
    }
    for (const [y, x, v] of POINTS) expect(Math.abs(out[y * 256 + x]! - v)).toBeLessThan(0.002);
  });

  it('rejects files that are not TFLite models', () => {
    expect(() => loadTflite(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toThrow(ModelError);
    expect(() => loadTflite(new TextEncoder().encode('<!doctype html><title>404</title>'))).toThrow(ModelError);
  });

  it('rejects input of the wrong size', () => {
    expect(() => loadTflite(bytes).run(new Float32Array(10))).toThrow(ModelError);
  });
});
