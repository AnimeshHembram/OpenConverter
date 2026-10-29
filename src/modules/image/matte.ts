/**
 * Turns the segmentation model's coarse 256 × 256 person probability map
 * into a full-resolution alpha matte that follows the photo's real edges.
 * Pure functions on typed arrays: no DOM, so they're unit-tested in Node.
 *
 * Steps:
 *  1. Drop small detached blobs (false positives such as street lights).
 *  2. Map probabilities to a soft initial alpha.
 *  3. In the uncertain band along the outline, estimate each pixel's
 *     coverage from its colour, between the local subject and background
 *     colours (sampling-based matting), at full resolution.
 */

export const MODEL_SIZE = 256;

/** Longest side of the grid the local colour estimates are made on. */
const WORK_SIDE = 1024;
/** Probabilities are mapped to alpha with a smoothstep between these. */
const P_LOW = 0.2;
const P_HIGH = 0.5;
/** Probability above which a cell counts as part of a region when looking for detached blobs. */
const P_REGION = 0.3;

const smoothstep = (lo: number, hi: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};


/**
 * Weights of a separable triangle (bilinear) filter that resamples `src`
 * samples to `dst`, widened when shrinking so large photos don't alias.
 * Same filter as Pillow's BILINEAR resize.
 */
function triangleWeights(src: number, dst: number): { start: Int32Array; weights: Float32Array[] } {
  const scale = src / dst;
  const support = Math.max(1, scale);
  const start = new Int32Array(dst);
  const weights: Float32Array[] = [];
  for (let i = 0; i < dst; i++) {
    const centre = (i + 0.5) * scale;
    const lo = Math.max(0, Math.floor(centre - support));
    const hi = Math.min(src, Math.ceil(centre + support));
    const w = new Float32Array(hi - lo);
    let sum = 0;
    for (let j = lo; j < hi; j++) {
      const v = Math.max(0, 1 - Math.abs((j + 0.5 - centre) / support));
      w[j - lo] = v;
      sum += v;
    }
    for (let k = 0; k < w.length; k++) w[k] = sum ? w[k]! / sum : 1 / w.length;
    start[i] = lo;
    weights.push(w);
  }
  return { start, weights };
}

/**
 * Model input: the image squashed to 256 × 256 (as MediaPipe does), RGB in
 * 0..1, resampled with a triangle filter.
 */
export function modelInput(rgba: ArrayLike<number>, width: number, height: number): Float32Array {
  const S = MODEL_SIZE;
  const fx = triangleWeights(width, S);
  const fy = triangleWeights(height, S);
  // Horizontal pass: height × S × 3.
  const tmp = new Float32Array(height * S * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < S; x++) {
      const w = fx.weights[x]!;
      const x0 = fx.start[x]!;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let k = 0; k < w.length; k++) {
        const o = (y * width + x0 + k) * 4;
        r += rgba[o]! * w[k]!;
        g += rgba[o + 1]! * w[k]!;
        b += rgba[o + 2]! * w[k]!;
      }
      const t = (y * S + x) * 3;
      tmp[t] = r;
      tmp[t + 1] = g;
      tmp[t + 2] = b;
    }
  }
  const out = new Float32Array(S * S * 3);
  for (let y = 0; y < S; y++) {
    const w = fy.weights[y]!;
    const y0 = fy.start[y]!;
    for (let x = 0; x < S; x++) {
      for (let c = 0; c < 3; c++) {
        let v = 0;
        for (let k = 0; k < w.length; k++) v += tmp[((y0 + k) * S + x) * 3 + c]! * w[k]!;
        out[(y * S + x) * 3 + c] = v / 255;
      }
    }
  }
  return out;
}

/** 8-connected components of `on`; returns a label per pixel (0 = off) and each label's size. */
function components(on: Uint8Array, w: number, h: number): { labels: Int32Array; sizes: number[] } {
  const labels = new Int32Array(w * h);
  const sizes = [0];
  const stack: number[] = [];
  for (let i = 0; i < on.length; i++) {
    if (!on[i] || labels[i]) continue;
    const id = sizes.length;
    let count = 0;
    labels[i] = id;
    stack.push(i);
    while (stack.length) {
      const j = stack.pop()!;
      count++;
      const x = j % w;
      const y = (j / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const k = ny * w + nx;
          if (on[k] && !labels[k]) {
            labels[k] = id;
            stack.push(k);
          }
        }
      }
    }
    sizes.push(count);
  }
  return { labels, sizes };
}

export interface PersonMask {
  /** Probability map after removing detached blobs, MODEL_SIZE². */
  prob: Float32Array;
  /** Share of the image the subject covers (0..1). */
  coverage: number;
  /** Mean probability inside the subject: how sure the model is. */
  confidence: number;
}

/**
 * Keep the main subject and anything comparably large; drop detached blobs
 * smaller than 3% of the largest one. Regions are found at a low threshold,
 * so less certain parts that are attached to the subject (legs in the dark,
 * a held object) stay with it.
 */
export function cleanProbabilities(prob: Float32Array): PersonMask {
  const n = MODEL_SIZE * MODEL_SIZE;
  const on = new Uint8Array(n);
  for (let i = 0; i < n; i++) on[i] = prob[i]! > P_REGION ? 1 : 0;
  const { labels, sizes } = components(on, MODEL_SIZE, MODEL_SIZE);
  const largest = Math.max(0, ...sizes.slice(1));
  const keep = sizes.map((s, i) => i > 0 && s >= largest * 0.03);
  // Keep the soft fringe of kept components: dilate the kept area by a few
  // cells, and zero everything else.
  const near = new Uint8Array(n);
  const R = 3;
  for (let y = 0; y < MODEL_SIZE; y++) {
    for (let x = 0; x < MODEL_SIZE; x++) {
      if (!keep[labels[y * MODEL_SIZE + x]!]) continue;
      for (let yy = Math.max(0, y - R); yy <= Math.min(MODEL_SIZE - 1, y + R); yy++) {
        for (let xx = Math.max(0, x - R); xx <= Math.min(MODEL_SIZE - 1, x + R); xx++) near[yy * MODEL_SIZE + xx] = 1;
      }
    }
  }
  const out = new Float32Array(n);
  let area = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    out[i] = near[i] ? prob[i]! : 0;
    if (keep[labels[i]!]) {
      area++;
      sum += prob[i]!;
    }
  }
  return { prob: out, coverage: area / n, confidence: area ? sum / area : 0 };
}

/** Box filter (mean over a (2r+1)² window, clipped at the borders) via an integral image. */
export function boxMean(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const ii = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += src[y * w + x]!;
      ii[(y + 1) * (w + 1) + x + 1] = ii[y * (w + 1) + x + 1]! + row;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const s = ii[y1 * (w + 1) + x1]! - ii[y0 * (w + 1) + x1]! - ii[y1 * (w + 1) + x0]! + ii[y0 * (w + 1) + x0]!;
      out[y * w + x] = s / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

/** Bilinear sample of a w×h grid at continuous coordinates (pixel centres at integers). */
function sample(grid: Float32Array, w: number, h: number, x: number, y: number): number {
  const fx = Math.min(w - 1, Math.max(0, x));
  const fy = Math.min(h - 1, Math.max(0, y));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const a = grid[y0 * w + x0]! * (1 - tx) + grid[y0 * w + x1]! * tx;
  const b = grid[y1 * w + x0]! * (1 - tx) + grid[y1 * w + x1]! * tx;
  return a * (1 - ty) + b * ty;
}

/** Raw model probabilities beyond these count as certain; between them is the outline band. */
const CERTAIN_BG = 0.1;
const CERTAIN_FG = 0.9;

/**
 * Full-resolution alpha (0..255, one byte per pixel) for the subject in
 * `rgba`, given the cleaned probability map. The output always has exactly
 * width × height entries, aligned with the input pixels.
 *
 * Where the model is certain, its answer is used. In the uncertain band
 * along the outline, each pixel's coverage is estimated from its own colour:
 * the local subject colour F and background colour B are averaged from
 * nearby certain pixels, and the pixel is placed on the line from B to F.
 * That snaps the outline to real edges and keeps strands of hair darker or
 * lighter than what's behind them. Where F and B are too alike to tell
 * apart (a dark coat on a dark street), the model's smooth estimate is kept.
 */
export function refineMatte(prob: Float32Array, rgba: ArrayLike<number>, width: number, height: number): Uint8Array {
  const scale = Math.min(1, WORK_SIDE / Math.max(width, height));
  const ww = Math.max(1, Math.round(width * scale));
  const wh = Math.max(1, Math.round(height * scale));
  const n = ww * wh;

  // Colour (area-averaged) and initial alpha on the working grid.
  const C = [new Float32Array(n), new Float32Array(n), new Float32Array(n)] as const;
  /** Raw probability, and the model-only alpha estimate. */
  const Q = new Float32Array(n);
  const P = new Float32Array(n);
  const fx = width / ww;
  const fy = height / wh;
  for (let y = 0; y < wh; y++) {
    const y0 = Math.floor(y * fy);
    const y1 = Math.max(y0 + 1, Math.min(height, Math.floor((y + 1) * fy)));
    for (let x = 0; x < ww; x++) {
      const x0 = Math.floor(x * fx);
      const x1 = Math.max(x0 + 1, Math.min(width, Math.floor((x + 1) * fx)));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const o = (yy * width + xx) * 4;
          r += rgba[o]!;
          g += rgba[o + 1]!;
          b += rgba[o + 2]!;
        }
      }
      const k = 255 * (y1 - y0) * (x1 - x0);
      const i = y * ww + x;
      C[0][i] = r / k;
      C[1][i] = g / k;
      C[2][i] = b / k;
      const p = sample(prob, MODEL_SIZE, MODEL_SIZE, ((x + 0.5) * MODEL_SIZE) / ww - 0.5, ((y + 0.5) * MODEL_SIZE) / wh - 0.5);
      Q[i] = p;
      P[i] = smoothstep(P_LOW, P_HIGH, p);
    }
  }

  // Local mean colours of certain subject and certain background pixels,
  // over a window a few model cells wide (box filters on masked sums).
  const R = Math.max(3, Math.round((6 * Math.max(ww, wh)) / MODEL_SIZE));
  const mF = new Float32Array(n);
  const mB = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    mF[i] = Q[i]! >= CERTAIN_FG ? 1 : 0;
    mB[i] = Q[i]! <= CERTAIN_BG ? 1 : 0;
  }
  const cF = boxMean(mF, ww, wh, R);
  const cB = boxMean(mB, ww, wh, R);
  const F: Float32Array[] = [];
  const B: Float32Array[] = [];
  const tmp = new Float32Array(n);
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < n; i++) tmp[i] = C[c]![i]! * mF[i]!;
    const f = boxMean(tmp, ww, wh, R);
    for (let i = 0; i < n; i++) tmp[i] = C[c]![i]! * mB[i]!;
    const b = boxMean(tmp, ww, wh, R);
    for (let i = 0; i < n; i++) {
      f[i] = cF[i]! > 1e-4 ? f[i]! / cF[i]! : -1;
      b[i] = cB[i]! > 1e-4 ? b[i]! / cB[i]! : -1;
    }
    F.push(f);
    B.push(b);
  }

  const alpha = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const gy = ((y + 0.5) * wh) / height - 0.5;
    for (let x = 0; x < width; x++) {
      const gx = ((x + 0.5) * ww) / width - 0.5;
      const i = y * width + x;
      let a = sample(P, ww, wh, gx, gy);
      const q = sample(Q, ww, wh, gx, gy);
      if (q > CERTAIN_BG && q < CERTAIN_FG) {
        const nearest = Math.min(wh - 1, Math.max(0, Math.round(gy))) * ww + Math.min(ww - 1, Math.max(0, Math.round(gx)));
        if (F[0]![nearest]! >= 0 && B[0]![nearest]! >= 0) {
          let d2 = 0;
          let dot = 0;
          for (let c = 0; c < 3; c++) {
            const f = sample(F[c]!, ww, wh, gx, gy);
            const b = sample(B[c]!, ww, wh, gx, gy);
            const v = f - b;
            d2 += v * v;
            dot += (rgba[i * 4 + c]! / 255 - b) * v;
          }
          const contrast = Math.sqrt(d2);
          // Trust colour only when subject and background clearly differ:
          // fully above ~64 levels, not at all below ~20.
          const w = Math.min(1, Math.max(0, (contrast - 0.08) / 0.17));
          if (w > 0) a = w * Math.min(1, Math.max(0, dot / d2)) + (1 - w) * a;
        }
      }
      // Flat regions become exactly opaque or clear.
      alpha[i] = Math.round(smoothstep(0.04, 0.96, a) * 255);
    }
  }
  return alpha;
}

/**
 * Multiply the image's alpha by the matte, in place. Colours are never
 * changed, so the subject keeps its original colours and detail; only
 * fully transparent pixels have their colour cleared.
 */
export function applyMatte(rgba: Uint8ClampedArray, alpha: Uint8Array): { removed: number } {
  let removed = 0;
  for (let i = 0; i < alpha.length; i++) {
    const o = i * 4;
    const a = Math.round((rgba[o + 3]! * alpha[i]!) / 255);
    if (a === 0) {
      if (rgba[o + 3] !== 0) removed++;
      rgba[o] = rgba[o + 1] = rgba[o + 2] = 0;
    }
    rgba[o + 3] = a;
  }
  return { removed };
}
