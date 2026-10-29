import { describe, expect, it } from 'vitest';
import { applyMatte, boxMean, cleanProbabilities, MODEL_SIZE, modelInput, refineMatte } from '../../src/modules/image/matte';

const S = MODEL_SIZE;

function rgbaImage(w: number, h: number, paint: (x: number, y: number) => [number, number, number]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set([...paint(x, y), 255], (y * w + x) * 4);
  return d;
}
/** A probability map painted at model resolution. */
function probMap(paint: (x: number, y: number) => number): Float32Array {
  const p = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) p[y * S + x] = paint(x, y);
  return p;
}

describe('modelInput', () => {
  it('squashes any image to 256 × 256 RGB in 0..1', () => {
    const d = rgbaImage(300, 100, () => [255, 51, 0]);
    const x = modelInput(d, 300, 100);
    expect(x.length).toBe(S * S * 3);
    expect(x[0]).toBeCloseTo(1, 5);
    expect(x[1]).toBeCloseTo(0.2, 5);
    expect(x[S * S * 3 - 1]).toBeCloseTo(0, 5);
  });

  it('keeps the left/right and top/bottom of the image in place', () => {
    const d = rgbaImage(512, 400, (x, y) => [x < 256 ? 255 : 0, y < 200 ? 255 : 0, 0]);
    const x = modelInput(d, 512, 400);
    const px = (xx: number, yy: number) => [...x.slice((yy * S + xx) * 3, (yy * S + xx) * 3 + 3)];
    expect(px(10, 10)[0]).toBeCloseTo(1, 3);
    expect(px(245, 10)[0]).toBeCloseTo(0, 3);
    expect(px(10, 245)[1]).toBeCloseTo(0, 3);
  });
});

describe('cleanProbabilities', () => {
  it('drops small detached blobs (e.g. a street light) and keeps the subject', () => {
    const p = probMap((x, y) => {
      if (x >= 80 && x < 180 && y >= 40 && y < 250) return 0.95; // subject
      if (Math.hypot(x - 20, y - 20) < 4) return 0.9; // small blob far away
      return 0;
    });
    const c = cleanProbabilities(p);
    expect(c.prob[20 * S + 20]).toBe(0);
    expect(c.prob[100 * S + 120]).toBeCloseTo(0.95, 5);
    expect(c.coverage).toBeGreaterThan(0.3);
    expect(c.confidence).toBeCloseTo(0.95, 2);
  });

  it('keeps less certain parts attached to the subject, such as legs in the dark', () => {
    const p = probMap((x, y) => {
      if (x >= 80 && x < 180 && y >= 40 && y < 160) return 0.95; // body
      if (x >= 100 && x < 160 && y >= 160 && y < 250) return 0.4; // legs, unsure
      return 0;
    });
    const c = cleanProbabilities(p);
    expect(c.prob[230 * S + 130]).toBeCloseTo(0.4, 5);
  });

  it('reports nothing found for an empty map', () => {
    const c = cleanProbabilities(new Float32Array(S * S));
    expect(c.coverage).toBe(0);
    expect(c.confidence).toBe(0);
  });
});

describe('boxMean', () => {
  it('averages over a clipped window', () => {
    const src = Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const m = boxMean(src, 3, 3, 1);
    expect(m[4]).toBeCloseTo(5, 6); // centre: all nine
    expect(m[0]).toBeCloseTo((1 + 2 + 4 + 5) / 4, 6); // corner: four
  });
});

describe('refineMatte', () => {
  it('returns one alpha value per input pixel, aligned with the image', () => {
    // Odd, non-square size; person on the left 40% only.
    const w = 333;
    const h = 211;
    const d = rgbaImage(w, h, (x) => (x < w * 0.4 ? [200, 150, 120] : [30, 40, 60]));
    const alpha = refineMatte(probMap((x) => (x < S * 0.4 ? 1 : 0)), d, w, h);
    expect(alpha.length).toBe(w * h);
    expect(alpha[100 * w + 20]).toBe(255);
    expect(alpha[100 * w + w - 20]).toBe(0);
    expect(alpha[5 * w + 20]).toBe(255); // top rows aren't shifted
    expect(alpha[(h - 5) * w + w - 5]).toBe(0);
  });

  it('snaps a coarse mask boundary to the real edge in the photo', () => {
    // At 1024 px wide each model cell is 4 px. The photo's edge is at
    // x = 400; the model's soft boundary (0.5) is 1.5 cells later, at
    // x = 406, fading over five cells as real model output does.
    const w = 1024;
    const h = 64;
    const d = rgbaImage(w, h, (x) => (x < 400 ? [220, 200, 180] : [20, 20, 30]));
    const alpha = refineMatte(probMap((x) => Math.min(1, Math.max(0, (104 - x) / 5))), d, w, h);
    const row = 32 * w;
    expect(alpha[row + 397]).toBeGreaterThan(240); // subject side of the real edge
    expect(alpha[row + 403]).toBeLessThan(15); // background side, though the model said "person"
  });

  it('keeps thin strands (hair) that are darker than the background between them', () => {
    // 1024 px, so a model cell is 4 px. Dark one-pixel strands every 4 px
    // stick out 24 px below a dark head onto a light background, inside the
    // six-cell fringe where the model's probability fades from 1 to 0.
    const w = 1024;
    const h = 1024;
    const d = rgbaImage(w, h, (x, y) => (y < 480 || (y < 504 && x % 4 === 0) ? [30, 25, 20] : [235, 235, 230]));
    const alpha = refineMatte(probMap((_x, y) => Math.min(1, Math.max(0, (126 - y) / 6))), d, w, h);
    for (const y of [484, 492, 500]) {
      const strand = alpha[y * w + 512]!;
      const gap = alpha[y * w + 514]!;
      expect(strand).toBeGreaterThan(200);
      expect(gap).toBeLessThan(40);
    }
    expect(alpha[470 * w + 514]).toBe(255); // the head itself
    expect(alpha[520 * w + 514]).toBe(0); // clear background
  });
});

describe('applyMatte', () => {
  it('keeps colours exactly, multiplies existing alpha, and clears fully transparent pixels', () => {
    const d = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 128, 70, 80, 90, 255]);
    const r = applyMatte(d, Uint8Array.from([255, 255, 0]));
    expect([...d.slice(0, 4)]).toEqual([10, 20, 30, 255]);
    expect([...d.slice(4, 8)]).toEqual([40, 50, 60, 128]);
    expect([...d.slice(8, 12)]).toEqual([0, 0, 0, 0]);
    expect(r.removed).toBe(1);
    const half = new Uint8ClampedArray([100, 110, 120, 200]);
    applyMatte(half, Uint8Array.from([128]));
    expect([...half]).toEqual([100, 110, 120, 100]);
  });
});
