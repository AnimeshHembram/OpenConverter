/**
 * Pixel edits applied before encoding: background removal and colour
 * treatments. Pure functions on RGBA bytes, so they're unit-tested without a
 * browser and behave identically in every engine.
 */
import type { ColourMode } from '../../core/types';

type Pixels = Uint8ClampedArray;

/** Pixels at or below this alpha already count as background. */
const SEE_THROUGH = 16;

export interface BackgroundRemoval {
  /** Pixels made fully transparent. */
  removed: number;
  /** Share (0..1) of opaque edge pixels that match the background colour. */
  edgeMatch: number;
  /** The colour treated as background, or null if the edges were already transparent. */
  colour: [number, number, number] | null;
}

/** Maps the 0..100 tolerance setting to a maximum RGB distance (of 441). */
export function toleranceDistance(tolerance: number): number {
  return 4 + (Math.min(100, Math.max(0, tolerance)) / 100) * 160;
}

/**
 * Find the dominant colour along the image's edges: edge pixels are binned
 * at 4 bits per channel and the busiest bin's average wins. Transparent edge
 * pixels are skipped.
 */
export function edgeColour(data: Pixels, width: number, height: number): [number, number, number] | null {
  const bins = new Map<number, [number, number, number, number]>();
  const visit = (i: number) => {
    const o = i * 4;
    if (data[o + 3]! <= SEE_THROUGH) return;
    const key = ((data[o]! >> 4) << 8) | ((data[o + 1]! >> 4) << 4) | (data[o + 2]! >> 4);
    const b = bins.get(key) ?? [0, 0, 0, 0];
    b[0] += data[o]!;
    b[1] += data[o + 1]!;
    b[2] += data[o + 2]!;
    b[3]++;
    bins.set(key, b);
  };
  forEachEdge(width, height, visit);
  let best: [number, number, number, number] | null = null;
  for (const b of bins.values()) if (!best || b[3] > best[3]) best = b;
  if (!best) return null;
  return [Math.round(best[0] / best[3]), Math.round(best[1] / best[3]), Math.round(best[2] / best[3])];
}

function forEachEdge(width: number, height: number, fn: (i: number) => void): void {
  for (let x = 0; x < width; x++) {
    fn(x);
    if (height > 1) fn((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y++) {
    fn(y * width);
    if (width > 1) fn(y * width + width - 1);
  }
}

/**
 * Make the background transparent, in place. The background is the region
 * connected to the image's edges whose colour is within `tolerance` of the
 * dominant edge colour, so a subject of a similar colour in the middle of the
 * image is kept. Pixels just outside the tolerance along the boundary get
 * partial transparency for a smoother edge.
 *
 * This suits product photos, logos, scans and screenshots on a plain
 * background. It doesn't recognise subjects, so it can't cut a person out of
 * a busy scene.
 */
export function removeBackground(data: Pixels, width: number, height: number, tolerance: number): BackgroundRemoval {
  const n = width * height;
  const colour = edgeColour(data, width, height);
  if (!colour) return { removed: 0, edgeMatch: 0, colour: null };
  const [br, bg, bb] = colour;
  const limit = toleranceDistance(tolerance);
  const limit2 = limit * limit;
  const soft = limit * 1.6;
  const dist2 = (i: number) => {
    const o = i * 4;
    const dr = data[o]! - br;
    const dg = data[o + 1]! - bg;
    const db = data[o + 2]! - bb;
    return dr * dr + dg * dg + db * db;
  };
  const isBackground = (i: number) => data[i * 4 + 3]! <= SEE_THROUGH || dist2(i) <= limit2;

  let edgeOpaque = 0;
  let edgeMatching = 0;
  forEachEdge(width, height, (i) => {
    if (data[i * 4 + 3]! <= SEE_THROUGH) return;
    edgeOpaque++;
    if (dist2(i) <= limit2) edgeMatching++;
  });

  // Scanline flood fill from every matching edge pixel. `mask` marks
  // background; the stack holds pixel indices and stays small in practice.
  const mask = new Uint8Array(n);
  let stack = new Int32Array(1024);
  let top = 0;
  const push = (i: number) => {
    if (top === stack.length) {
      const bigger = new Int32Array(stack.length * 2);
      bigger.set(stack);
      stack = bigger;
    }
    stack[top++] = i;
  };
  forEachEdge(width, height, (i) => {
    if (!mask[i] && isBackground(i)) push(i);
  });
  while (top > 0) {
    const i = stack[--top]!;
    if (mask[i] || !isBackground(i)) continue;
    const y = (i / width) | 0;
    const row = y * width;
    let l = i - row;
    let r = l;
    while (l > 0 && !mask[row + l - 1] && isBackground(row + l - 1)) l--;
    while (r < width - 1 && !mask[row + r + 1] && isBackground(row + r + 1)) r++;
    for (let x = l; x <= r; x++) mask[row + x] = 1;
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= height) continue;
      const nrow = ny * width;
      let inRun = false;
      for (let x = l; x <= r; x++) {
        const j = nrow + x;
        const open = !mask[j] && isBackground(j);
        if (open && !inRun) push(j);
        inRun = open;
      }
    }
  }

  let removed = 0;
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    const o = i * 4;
    if (data[o + 3] !== 0) removed++;
    data[o] = data[o + 1] = data[o + 2] = data[o + 3] = 0;
  }

  // Feather: foreground pixels touching the background that are still close
  // to its colour become partly transparent.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (mask[i]) continue;
      const touches =
        (x > 0 && mask[i - 1]) || (x < width - 1 && mask[i + 1]) || (y > 0 && mask[i - width]) || (y < height - 1 && mask[i + width]);
      if (!touches) continue;
      const d = Math.sqrt(dist2(i));
      if (d >= soft) continue;
      const keep = (d - limit) / (soft - limit);
      data[i * 4 + 3] = Math.round(data[i * 4 + 3]! * Math.min(1, Math.max(0, keep)));
    }
  }

  return { removed, edgeMatch: edgeOpaque ? edgeMatching / edgeOpaque : 1, colour };
}

/** Rec. 709 luma of one pixel, 0..255. */
const luma = (data: Pixels, o: number) => 0.2126 * data[o]! + 0.7152 * data[o + 1]! + 0.0722 * data[o + 2]!;

/**
 * Otsu's threshold over the luma of the visible pixels: the cut that best
 * separates dark from light, so black-and-white output adapts to each image.
 */
export function otsuThreshold(data: Pixels): number {
  const hist = new Float64Array(256);
  let total = 0;
  for (let o = 0; o < data.length; o += 4) {
    if (data[o + 3]! <= SEE_THROUGH) continue;
    const k = Math.round(luma(data, o));
    hist[k] = hist[k]! + 1;
    total++;
  }
  if (!total) return 128;
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t]!;
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t]!;
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  // Pixels at or below the threshold become black.
  return threshold;
}

/** Apply a colour treatment in place. Transparency is kept. */
export function applyColour(data: Pixels, mode: ColourMode): void {
  if (mode === 'original') return;
  const threshold = mode === 'bw' ? otsuThreshold(data) : 0;
  for (let o = 0; o < data.length; o += 4) {
    const y = luma(data, o);
    const v = mode === 'bw' ? (y <= threshold ? 0 : 255) : Math.round(y);
    data[o] = data[o + 1] = data[o + 2] = v;
  }
}
