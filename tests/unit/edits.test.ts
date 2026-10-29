import { describe, expect, it } from 'vitest';
import { applyColour, edgeColour, otsuThreshold, removeBackground } from '../../src/modules/image/edits';

/** Build an RGBA image from a painter (x, y) -> [r, g, b, a]. */
function image(width: number, height: number, paint: (x: number, y: number) => [number, number, number, number]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(paint(x, y), (y * width + x) * 4);
  return data;
}
const alphaAt = (d: Uint8ClampedArray, w: number, x: number, y: number) => d[(y * w + x) * 4 + 3];

describe('removeBackground', () => {
  // A red 4×4 square on a white 10×10 background.
  const square = () => image(10, 10, (x, y) => (x >= 3 && x <= 6 && y >= 3 && y <= 6 ? [220, 20, 20, 255] : [255, 255, 255, 255]));

  it('makes a plain background transparent and keeps the subject', () => {
    const d = square();
    const r = removeBackground(d, 10, 10, 25);
    expect(r.colour).toEqual([255, 255, 255]);
    expect(r.edgeMatch).toBe(1);
    expect(r.removed).toBe(100 - 16);
    expect(alphaAt(d, 10, 0, 0)).toBe(0);
    expect(alphaAt(d, 10, 9, 9)).toBe(0);
    for (let y = 3; y <= 6; y++) for (let x = 3; x <= 6; x++) expect(alphaAt(d, 10, x, y)).toBe(255);
  });

  it('tolerates JPEG-like noise in the background', () => {
    const d = image(12, 12, (x, y) => (x >= 4 && x <= 7 && y >= 4 && y <= 7 ? [0, 0, 0, 255] : [250 - ((x * 7 + y * 3) % 9), 252, 249, 255]));
    removeBackground(d, 12, 12, 25);
    expect(alphaAt(d, 12, 0, 0)).toBe(0);
    expect(alphaAt(d, 12, 11, 5)).toBe(0);
    expect(alphaAt(d, 12, 5, 5)).toBe(255);
  });

  it('keeps background-coloured areas that are enclosed by the subject', () => {
    // A black ring with a white centre: the centre isn't connected to the edges.
    const d = image(9, 9, (x, y) => {
      const ring = x >= 2 && x <= 6 && y >= 2 && y <= 6 && !(x >= 3 && x <= 5 && y >= 3 && y <= 5);
      return ring ? [0, 0, 0, 255] : [255, 255, 255, 255];
    });
    removeBackground(d, 9, 9, 25);
    expect(alphaAt(d, 9, 0, 0)).toBe(0);
    expect(alphaAt(d, 9, 4, 4)).toBe(255); // the hole stays
    expect(alphaAt(d, 9, 2, 2)).toBe(255);
  });

  it('reports a low edge match for busy backgrounds', () => {
    const d = image(10, 10, (x, y) => ((x + y) % 2 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const r = removeBackground(d, 10, 10, 10);
    expect(r.edgeMatch).toBeLessThan(0.6);
  });

  // Replaces the earlier "feathers boundary pixels close to the background
  // colour" test: edge transparency now comes from how much of the subject
  // colour each outline pixel contains, not from the tolerance setting, so a
  // blended edge never leaves a fringe of the old background behind.
  it('gives blended outline pixels their real coverage and removes the background colour from them', () => {
    // A white disc on black: a one-pixel ring of 50% grey is an anti-aliased edge.
    const d = image(11, 11, (x, y) => {
      const r = Math.hypot(x - 5, y - 5);
      if (r <= 2.5) return [240, 240, 240, 255];
      if (r <= 3.5) return [120, 120, 120, 255];
      return [0, 0, 0, 255];
    });
    removeBackground(d, 11, 11, 25);
    const ring = (5 + 3) * 4; // (x 8, y 5) in a row-major RGBA array of width 11
    const o = 5 * 11 * 4 + ring;
    expect(d[o + 3]).toBeGreaterThan(100);
    expect(d[o + 3]).toBeLessThan(155); // about half covered
    // Unmixed back to the disc's colour: no dark fringe once composited.
    expect(d[o]).toBeGreaterThan(225);
    expect(alphaAt(d, 11, 5, 5)).toBe(255);
    expect(alphaAt(d, 11, 0, 0)).toBe(0);
  });

  it('uses the tolerance to decide which colours count as background', () => {
    // A light grey band (25 from white) between the white edge and the subject.
    const banded = () =>
      image(12, 12, (x, y) => {
        if (x >= 5 && x <= 6 && y >= 5 && y <= 6) return [200, 0, 0, 255];
        if (x >= 2 && x <= 9 && y >= 2 && y <= 9) return [240, 240, 240, 255];
        return [255, 255, 255, 255];
      });
    const loose = banded();
    removeBackground(loose, 12, 12, 25); // limit 44: the band is background
    expect(alphaAt(loose, 12, 3, 3)).toBe(0);
    const strict = banded();
    removeBackground(strict, 12, 12, 0); // limit 4: the band is kept
    expect(alphaAt(strict, 12, 3, 3)).toBe(255);
    expect(alphaAt(strict, 12, 0, 0)).toBe(0);
  });

  it('does nothing when the edges are already transparent', () => {
    const d = image(4, 4, (x, y) => (x === 0 || y === 0 || x === 3 || y === 3 ? [0, 0, 0, 0] : [10, 20, 30, 255]));
    const r = removeBackground(d, 4, 4, 50);
    expect(r.colour).toBeNull();
    expect(r.removed).toBe(0);
    expect(alphaAt(d, 4, 1, 1)).toBe(255);
  });

  it('handles 1-pixel-wide and 1-pixel-tall images', () => {
    expect(removeBackground(image(1, 5, () => [9, 9, 9, 255]), 1, 5, 25).removed).toBe(5);
    expect(removeBackground(image(5, 1, () => [9, 9, 9, 255]), 5, 1, 25).removed).toBe(5);
  });

  it('copes with a large image without overflowing the stack', () => {
    const w = 1500;
    const h = 1000;
    const d = image(w, h, (x, y) => ((x - 750) ** 2 + (y - 500) ** 2 < 200 ** 2 ? [0, 120, 0, 255] : [240, 240, 240, 255]));
    const r = removeBackground(d, w, h, 25);
    expect(r.removed).toBeGreaterThan(w * h * 0.8);
    expect(alphaAt(d, w, 750, 500)).toBe(255);
  });
});

describe('edgeColour', () => {
  it('picks the most common edge colour', () => {
    const d = image(6, 6, (x) => (x === 0 ? [0, 0, 255, 255] : [0, 200, 0, 255]));
    expect(edgeColour(d, 6, 6)).toEqual([0, 200, 0]);
  });
});

describe('applyColour', () => {
  it('converts to grayscale with Rec. 709 weights and keeps alpha', () => {
    const d = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0]);
    applyColour(d, 'grayscale');
    expect([...d]).toEqual([54, 54, 54, 255, 182, 182, 182, 128, 18, 18, 18, 0]);
  });

  it('makes a two-tone black and white image with an adaptive threshold', () => {
    // Dark grey text on a light grey page: both are grey, neither is pure.
    const d = image(10, 1, (x) => (x < 3 ? [60, 60, 60, 255] : [200, 200, 200, 255]));
    applyColour(d, 'bw');
    const values = new Set<number>();
    for (let o = 0; o < d.length; o += 4) values.add(d[o]!);
    expect([...values].sort((a, b) => a - b)).toEqual([0, 255]);
    expect(d[0]).toBe(0);
    expect(d[9 * 4]).toBe(255);
  });

  it('leaves the image alone for "original"', () => {
    const d = new Uint8ClampedArray([1, 2, 3, 4]);
    applyColour(d, 'original');
    expect([...d]).toEqual([1, 2, 3, 4]);
  });

  it('finds a threshold between two clusters', () => {
    const d = image(10, 1, (x) => (x < 5 ? [40, 40, 40, 255] : [210, 210, 210, 255]));
    const t = otsuThreshold(d);
    expect(t).toBeGreaterThanOrEqual(40);
    expect(t).toBeLessThan(210);
  });
});
