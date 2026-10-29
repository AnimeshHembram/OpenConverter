/**
 * Pixel edits applied before encoding: background removal and colour
 * treatments. Pure functions on RGBA bytes, so they're unit-tested without a
 * browser and behave identically in every engine.
 */
import type { ColourMode } from '../../core/types';

type Pixels = Uint8ClampedArray;

/** Pixels at or below this alpha already count as background. */
const SEE_THROUGH = 16;
/** Shadows are only looked for on backgrounds at least this bright (luma, 0..255). */
const SHADOW_MIN_LUMA = 96;
/** Largest brightness change between neighbouring pixels inside a soft shadow. */
const SHADOW_STEP = 6;

export interface BackgroundRemoval {
  /** Pixels made fully transparent. */
  removed: number;
  /** Share (0..1) of opaque edge pixels that match the background colour. */
  edgeMatch: number;
  /** The colour treated as background, or null if the edges were already transparent. */
  colour: [number, number, number] | null;
  /**
   * Share (0..1) of the kept region's outline that differs clearly from the
   * background colour. A real subject on a plain background has a crisp
   * outline; when the fill stops in noise, shading or glow, it doesn't.
   */
  boundaryContrast: number;
  /** Share (0..1) of the image the background region covers. */
  coverage: number;
  /** Whether the colour key can be trusted on this image (see `isPlainBackground`). */
  plain: boolean;
}

export interface BackgroundAnalysis extends BackgroundRemoval {
  /** 1 for pixels in the background region, connected to the image's edges. */
  mask: Uint8Array;
  /** Maximum RGB distance from the background colour that still counts as background. */
  limit: number;
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
 * When the colour key is reliable: the edges are (almost) all one colour,
 * the region it finds is neither nothing nor everything, and the outline of
 * what remains is mostly crisp. A dark subject on a dark background, glow
 * around lights, or a textured scene fails the outline test, and the key is
 * then not used, rather than cutting holes in the subject.
 */
export function isPlainBackground(r: Pick<BackgroundRemoval, 'edgeMatch' | 'boundaryContrast' | 'coverage'>): boolean {
  return r.edgeMatch >= 0.85 && r.boundaryContrast >= 0.6 && r.coverage >= 0.02 && r.coverage <= 0.97;
}

/**
 * Find the background region without changing any pixels: the region
 * connected to the image's edges whose colour is within `tolerance` of the
 * dominant edge colour. A subject of a similar colour in the middle of the
 * image is kept. This is a colour key: it suits product photos, logos, scans
 * and screenshots on a plain background, and doesn't recognise subjects.
 */
export function analyseBackground(data: Pixels, width: number, height: number, tolerance: number): BackgroundAnalysis {
  const n = width * height;
  const mask = new Uint8Array(n);
  const colour = edgeColour(data, width, height);
  const limit = toleranceDistance(tolerance);
  if (!colour) {
    return { mask, limit, removed: 0, edgeMatch: 0, colour: null, boundaryContrast: 0, coverage: 0, plain: false };
  }
  const [br, bg, bb] = colour;
  const limit2 = limit * limit;
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

  // Scanline flood fill from every matching edge pixel.
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

  // Soft shadows on a light background: grow the region into neighbouring
  // pixels that are darker versions of the background colour (same hue) and
  // change only gradually, as a cast shadow does. A crisp edge, even of a
  // grey object, stops the growth. These pixels are kept as see-through
  // black by `applyBackgroundKey`.
  const bgLuma = 0.2126 * br + 0.7152 * bg + 0.0722 * bb;
  if (bgLuma >= SHADOW_MIN_LUMA) {
    const lum = (i: number) => 0.2126 * data[i * 4]! + 0.7152 * data[i * 4 + 1]! + 0.0722 * data[i * 4 + 2]!;
    const shadowLike = (i: number) => {
      const o = i * 4;
      if (data[o + 3]! <= SEE_THROUGH) return false;
      const l = lum(i);
      if (l >= bgLuma || l < bgLuma * 0.35) return false;
      const k = l / bgLuma; // the background colour scaled down to this brightness
      return Math.hypot(data[o]! - br * k, data[o + 1]! - bg * k, data[o + 2]! - bb * k) <= 10 + limit * 0.25;
    };
    const queue: number[] = [];
    for (let i = 0; i < n; i++) if (mask[i]) queue.push(i);
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q]!;
      const x = i % width;
      const li = lum(i);
      const visit = (j: number) => {
        if (mask[j] || !shadowLike(j) || Math.abs(lum(j) - li) > SHADOW_STEP) return;
        mask[j] = 1;
        queue.push(j);
      };
      if (x > 0) visit(i - 1);
      if (x < width - 1) visit(i + 1);
      if (i >= width) visit(i - width);
      if (i + width < n) visit(i + width);
    }
  }

  // Outline quality: kept pixels next to the background, and how many of
  // them differ clearly from it. Anti-aliased edges of a crisp subject are
  // still well beyond twice the tolerance distance.
  const strong = Math.max(2 * limit, 48) ** 2;
  let outline = 0;
  let crisp = 0;
  let background = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (mask[i]) {
        background++;
        continue;
      }
      const touches =
        (x > 0 && mask[i - 1]) || (x < width - 1 && mask[i + 1]) || (y > 0 && mask[i - width]) || (y < height - 1 && mask[i + width]);
      if (!touches || data[i * 4 + 3]! <= SEE_THROUGH) continue;
      outline++;
      if (dist2(i) >= strong) crisp++;
    }
  }
  const result = {
    mask,
    limit,
    removed: 0,
    edgeMatch: edgeOpaque ? edgeMatching / edgeOpaque : 1,
    colour,
    boundaryContrast: outline ? crisp / outline : 0,
    coverage: n ? background / n : 0,
  };
  return { ...result, plain: isPlainBackground(result) };
}

/**
 * Apply a colour key found by `analyseBackground`, in place. Returns the
 * number of pixels made fully transparent.
 *
 * - Background pixels become transparent, except shadows: background pixels
 *   clearly darker than the background colour are kept as see-through black,
 *   so a product's shadow survives on a new background.
 * - Subject pixels on the outline get the transparency of their blend with
 *   the background, and the background colour is taken out of them
 *   ("unmixing"), so no light or dark fringe is left around the subject.
 * - Every other pixel is left exactly as it was.
 */
export function applyBackgroundKey(data: Pixels, width: number, height: number, a: BackgroundAnalysis): number {
  if (!a.colour) return 0;
  const { mask, limit } = a;
  const [br, bg, bb] = a.colour;
  const soft = limit * 1.6;
  const bgLuma = 0.2126 * br + 0.7152 * bg + 0.0722 * bb;
  const keepShadows = bgLuma >= SHADOW_MIN_LUMA; // on dark backgrounds a shadow can't be told apart
  const dist = (o: number) => Math.hypot(data[o]! - br, data[o + 1]! - bg, data[o + 2]! - bb);

  // Outline pixels (subject pixels touching the background) are usually a
  // blend of subject and background. Estimate each one's coverage from the
  // subject colour just inside the outline, then take the background colour
  // out of it ("unmixing"), so no light or dark fringe is left behind.
  const touchesBg = (x: number, y: number, i: number) =>
    (x > 0 && mask[i - 1]) || (x < width - 1 && mask[i + 1]) || (y > 0 && mask[i - width]) || (y < height - 1 && mask[i + width]);
  const updates: [number, number, number, number, number][] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (mask[i] || !touchesBg(x, y, i)) continue;
      const o = i * 4;
      // The most subject-like pixel nearby that isn't itself on the outline.
      let fr = -1;
      let fg = 0;
      let fb = 0;
      let best = 0;
      for (let dy = -2; dy <= 2; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          const j = yy * width + xx;
          if (mask[j] || touchesBg(xx, yy, j)) continue;
          const d = dist(j * 4);
          if (d > best) {
            best = d;
            fr = data[j * 4]!;
            fg = data[j * 4 + 1]!;
            fb = data[j * 4 + 2]!;
          }
        }
      }
      let keep: number;
      if (fr >= 0 && best > limit) {
        // Project the pixel onto the line from background to subject colour.
        const vr = fr - br;
        const vg = fg - bg;
        const vb = fb - bb;
        keep = ((data[o]! - br) * vr + (data[o + 1]! - bg) * vg + (data[o + 2]! - bb) * vb) / (vr * vr + vg * vg + vb * vb);
      } else {
        // No solid subject nearby (a thin line): fall back to the distance.
        const d = dist(o);
        keep = (d - limit) / (soft - limit);
      }
      keep = Math.min(1, Math.max(0, keep));
      if (keep >= 0.98) continue;
      const k = Math.max(keep, 0.05);
      updates.push([
        o,
        (data[o]! - (1 - k) * br) / k,
        (data[o + 1]! - (1 - k) * bg) / k,
        (data[o + 2]! - (1 - k) * bb) / k,
        Math.round(data[o + 3]! * keep),
      ]);
    }
  }
  // Applied afterwards so every estimate used the original colours.
  for (const [o, r, g, b, a] of updates) {
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
    data[o + 3] = a;
  }

  let removed = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const o = i * 4;
    let shadow = 0;
    if (keepShadows) {
      const l = 0.2126 * data[o]! + 0.7152 * data[o + 1]! + 0.0722 * data[o + 2]!;
      // How much darker than the background, ignoring compression noise.
      shadow = Math.min(1, Math.max(0, (1 - l / bgLuma - 0.06) / 0.94));
    }
    const alpha = Math.round(data[o + 3]! * shadow);
    if (alpha === 0) {
      if (data[o + 3] !== 0) removed++;
      data[o] = data[o + 1] = data[o + 2] = data[o + 3] = 0;
    } else {
      data[o] = data[o + 1] = data[o + 2] = 0;
      data[o + 3] = alpha;
    }
  }
  return removed;
}

/**
 * Colour-key background removal in one step: analyse, then apply whatever
 * the analysis found, plain or not. The converter uses the two halves
 * separately so it can decline unreliable keys.
 */
export function removeBackground(data: Pixels, width: number, height: number, tolerance: number): BackgroundRemoval {
  const a = analyseBackground(data, width, height, tolerance);
  const removed = applyBackgroundKey(data, width, height, a);
  return { removed, edgeMatch: a.edgeMatch, colour: a.colour, boundaryContrast: a.boundaryContrast, coverage: a.coverage, plain: a.plain };
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
