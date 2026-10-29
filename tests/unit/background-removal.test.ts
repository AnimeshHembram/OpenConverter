import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConversionError } from '../../src/core/errors';
import { removeImageBackground } from '../../src/modules/image/converter';
import { analyseBackground } from '../../src/modules/image/edits';
import { segmenterFromModel, type Segmenter } from '../../src/modules/image/segment';
import { loadTflite } from '../../src/modules/image/tflite';
import { darkOnDark, hairOnLight, lightOnDark, productWithShadow, rainyStreet, score, type Scene } from '../fixtures/scenes';

/**
 * Background removal on synthetic photographs with known ground truth,
 * through the same entry point the converter uses, with the real model.
 * Every check is on pixels; the dark rainy street is the case from the bug
 * report.
 */

const require = createRequire(import.meta.url);
const modelBytes = new Uint8Array(
  readFileSync(join(dirname(require.resolve('@mediapipe/selfie_segmentation/package.json')), 'selfie_segmentation.tflite')),
);
const segmenter = segmenterFromModel(loadTflite(modelBytes));
const never = new AbortController().signal;

/** `seg: null` runs without the model, as the standalone file does. */
async function run(scene: Scene, seg: Segmenter | null = segmenter, tolerance = 25) {
  const img = { width: scene.width, height: scene.height, data: new Uint8ClampedArray(scene.rgba) };
  const notes = await removeImageBackground(img, tolerance, seg ?? undefined, never);
  return { out: img.data, notes, ...score(scene, img.data) };
}
const pixel = (d: Uint8ClampedArray, w: number, x: number, y: number) => [...d.slice((y * w + x) * 4, (y * w + x) * 4 + 4)];

describe('dark subjects against dark backgrounds (the rainy-street regression)', () => {
  it('the colour key alone would destroy the subject, so it is not used', () => {
    const scene = rainyStreet();
    const key = analyseBackground(new Uint8ClampedArray(scene.rgba), scene.width, scene.height, 25);
    expect(key.plain).toBe(false);
  });

  it('keeps the dark coat and hair, and removes street lights, windows and reflections', async () => {
    const scene = rainyStreet();
    const r = await run(scene);
    expect(r.subjectKept).toBeGreaterThan(0.9);
    expect(r.backgroundLeft).toBeLessThan(0.08);
    expect(r.iou).toBeGreaterThan(0.65);
    expect(pixel(r.out, 640, 333, 450)[3]).toBe(255); // middle of the coat
    expect(pixel(r.out, 640, 333, 240)[3]).toBe(255); // dark hair
    expect(pixel(r.out, 640, 90, 180)[3]).toBe(0); // street light
    expect(pixel(r.out, 640, 560, 150)[3]).toBe(0);
  });

  it('still finds the person when the photo is twice as dark (low light)', async () => {
    const r = await run(rainyStreet(640, 800, 0.5));
    expect(r.subjectKept).toBeGreaterThan(0.85);
    expect(r.backgroundLeft).toBeLessThan(0.08);
  });

  it('works the same on a smaller copy of the photo', async () => {
    const r = await run(rainyStreet(320, 400));
    expect(r.subjectKept).toBeGreaterThan(0.9);
    expect(r.iou).toBeGreaterThan(0.6);
  });

  it('refuses a dark object on a dark backdrop with no person, leaving the pixels untouched', async () => {
    const scene = darkOnDark();
    const img = { width: scene.width, height: scene.height, data: new Uint8ClampedArray(scene.rgba) };
    await expect(removeImageBackground(img, 25, segmenter, never)).rejects.toThrow(ConversionError);
    await expect(removeImageBackground(img, 25, segmenter, never)).rejects.toThrow(/Nothing was changed/);
    expect(img.data).toEqual(scene.rgba);
  });
});

describe('original image preservation', () => {
  it('never changes the colour of opaque subject pixels, and keeps size and alignment', async () => {
    const scene = rainyStreet(320, 400);
    const r = await run(scene);
    expect(r.out.length).toBe(scene.rgba.length);
    let opaque = 0;
    for (let i = 0; i < scene.subject.length; i++) {
      if (r.out[i * 4 + 3] !== 255) continue;
      opaque++;
      expect(r.out[i * 4]).toBe(scene.rgba[i * 4]);
      expect(r.out[i * 4 + 1]).toBe(scene.rgba[i * 4 + 1]);
      expect(r.out[i * 4 + 2]).toBe(scene.rgba[i * 4 + 2]);
    }
    expect(opaque).toBeGreaterThan(5000);
  });

  it('makes removed pixels fully transparent (alpha 0), not black and opaque', async () => {
    const r = await run(rainyStreet(320, 400));
    const corner = pixel(r.out, 320, 2, 2);
    expect(corner[3]).toBe(0);
    let opaqueBlack = 0;
    for (let i = 0; i < r.out.length; i += 4) if (r.out[i + 3] === 255 && r.out[i]! + r.out[i + 1]! + r.out[i + 2]! === 0) opaqueBlack++;
    expect(opaqueBlack).toBe(0);
  });
});

describe('light subjects against dark backgrounds', () => {
  it('uses the colour key, with no dark fringe around the subject', async () => {
    const scene = lightOnDark();
    const r = await run(scene);
    expect(r.subjectKept).toBeGreaterThan(0.98);
    expect(r.backgroundLeft).toBeLessThan(0.01);
    for (let i = 0; i < scene.subject.length; i++) {
      const a = r.out[i * 4 + 3]!;
      if (a > 0 && a < 255) expect(r.out[i * 4 + 1]).toBeGreaterThan(180);
    }
  });
});

describe('hair and fine edges', () => {
  it('keeps one-pixel strands of hair on a plain background', async () => {
    const scene = hairOnLight();
    const r = await run(scene);
    expect(r.subjectKept).toBeGreaterThan(0.95);
    // Strand pixels (thin, partly covered) mostly survive.
    let strands = 0;
    let kept = 0;
    for (let i = 0; i < scene.subject.length; i++) {
      const x = i % scene.width;
      const y = (i / scene.width) | 0;
      const inHead = ((x - 100) / 45) ** 2 + ((y - 120) / 60) ** 2 <= 1.05;
      if (inHead || scene.subject[i]! < 0.5) continue;
      strands++;
      if (r.out[i * 4 + 3]! > 64) kept++;
    }
    expect(strands).toBeGreaterThan(50);
    expect(kept / strands).toBeGreaterThan(0.8);
  });
});

describe('shadows', () => {
  it("keeps a product's soft shadow as see-through black, and the product exactly as it was", async () => {
    const scene = productWithShadow();
    const r = await run(scene);
    expect(r.notes).toEqual([]);
    expect(pixel(r.out, 240, 120, 95)).toEqual(pixel(scene.rgba, 240, 120, 95));
    const shadow = pixel(r.out, 240, 128, 155);
    expect(shadow[3]).toBeGreaterThan(40);
    expect(shadow[3]).toBeLessThan(200);
    expect(shadow.slice(0, 3)).toEqual([0, 0, 0]);
    expect(pixel(r.out, 240, 5, 5)[3]).toBe(0);
    expect(pixel(r.out, 240, 235, 100)[3]).toBe(0); // backdrop far from the shadow
  });
});

describe('without the model (standalone file)', () => {
  it('still removes plain backgrounds', async () => {
    const r = await run(productWithShadow(), null);
    expect(r.subjectKept).toBeGreaterThan(0.99);
  });

  it('refuses photos and says the online version is needed', async () => {
    await expect(run(rainyStreet(320, 400), null)).rejects.toThrow(/online version/);
  });
});
