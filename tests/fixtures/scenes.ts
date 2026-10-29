/**
 * Deterministic synthetic photographs with known ground truth, for
 * background-removal regression tests. Pure TypeScript (no canvas), so the
 * same pixels are used by the unit tests in Node and the browser tests.
 *
 * Each scene returns RGBA pixels and `subject`, the true foreground coverage
 * (0..1) of every pixel, so results can be scored pixel by pixel.
 */

export interface Scene {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  /** Ground-truth subject coverage per pixel, 0..1. */
  subject: Float32Array;
}

/** Small seeded PRNG (mulberry32), so scenes are identical on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Gaussian noise from a uniform PRNG (Box–Muller). */
function gauss(r: () => number): number {
  return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
}

type Inside = (x: number, y: number) => boolean;
type RGB = [number, number, number];

class Canvas {
  readonly px: Float32Array;
  readonly subject: Float32Array;
  constructor(readonly width: number, readonly height: number, fill: (x: number, y: number) => RGB) {
    this.px = new Float32Array(width * height * 3);
    this.subject = new Float32Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) this.px.set(fill(x, y), (y * width + x) * 3);
  }
  /** Anti-aliased fill (4×4 supersampling) of a shape, optionally marking it as subject. */
  shape(inside: Inside, colour: RGB | ((x: number, y: number) => RGB), box: [number, number, number, number], subject = false, opacity = 1) {
    const [x0, y0, x1, y1] = box.map(Math.round) as [number, number, number, number];
    for (let y = Math.max(0, y0); y < Math.min(this.height, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(this.width, x1); x++) {
        let hits = 0;
        for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) if (inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) hits++;
        if (!hits) continue;
        const a = (hits / 16) * opacity;
        const c = typeof colour === 'function' ? colour(x, y) : colour;
        const i = y * this.width + x;
        for (let k = 0; k < 3; k++) this.px[i * 3 + k] = this.px[i * 3 + k]! * (1 - a) + c[k]! * a;
        if (subject) this.subject[i] = this.subject[i]! + (1 - this.subject[i]!) * a;
      }
    }
  }
  /** Anti-aliased line of a given width. */
  line(x0: number, y0: number, x1: number, y1: number, w: number, colour: RGB, subject = false, opacity = 1) {
    const len2 = (x1 - x0) ** 2 + (y1 - y0) ** 2;
    const inside: Inside = (x, y) => {
      const t = Math.max(0, Math.min(1, ((x - x0) * (x1 - x0) + (y - y0) * (y1 - y0)) / len2));
      return Math.hypot(x - (x0 + t * (x1 - x0)), y - (y0 + t * (y1 - y0))) <= w / 2;
    };
    this.shape(inside, colour, [Math.min(x0, x1) - w, Math.min(y0, y1) - w, Math.max(x0, x1) + w + 1, Math.max(y0, y1) + w + 1], subject, opacity);
  }
  add(f: (x: number, y: number) => RGB) {
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const d = f(x, y);
        const o = (y * this.width + x) * 3;
        this.px[o] = this.px[o]! + d[0];
        this.px[o + 1] = this.px[o + 1]! + d[1];
        this.px[o + 2] = this.px[o + 2]! + d[2];
      }
    }
  }
  done(noise = 0, seed = 1): Scene {
    const r = rng(seed);
    const rgba = new Uint8ClampedArray(this.width * this.height * 4);
    for (let i = 0; i < this.width * this.height; i++) {
      for (let k = 0; k < 3; k++) rgba[i * 4 + k] = Math.round(this.px[i * 3 + k]! + (noise ? gauss(r) * noise : 0));
      rgba[i * 4 + 3] = 255;
    }
    return { width: this.width, height: this.height, rgba, subject: this.subject };
  }
}

const ellipse = (cx: number, cy: number, rx: number, ry: number): Inside => (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
const rect = (x0: number, y0: number, x1: number, y1: number): Inside => (x, y) => x >= x0 && x < x1 && y >= y0 && y < y1;
function polygon(pts: [number, number][]): Inside {
  return (x, y) => {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i]!;
      const [xj, yj] = pts[j]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
}

/** A standing person in a dark coat, with dark hair, centred at `cx`; sizes are for an 800-px-tall frame times `s`. */
function person(c: Canvas, cx: number, s: number, coat: RGB, seed: number) {
  const r = rng(seed);
  const Y = (v: number) => v * s;
  const X = (v: number) => cx + v * s;
  // Legs, coat, shoulders, neck, head (skin), then hair.
  c.shape(rect(X(-62), Y(555), X(-18), Y(790)), [coat[0] - 6, coat[1] - 6, coat[2] - 4], [X(-62), Y(555), X(-18), Y(790)], true);
  c.shape(rect(X(18), Y(555), X(62), Y(790)), [coat[0] - 6, coat[1] - 6, coat[2] - 4], [X(18), Y(555), X(62), Y(790)], true);
  c.shape(polygon([[X(-90), Y(320)], [X(90), Y(320)], [X(105), Y(565)], [X(-105), Y(565)]]), (x, y) => {
    const fold = Math.sin((x - cx) / (9 * s)) * 3 + Math.sin(y / (23 * s)) * 2;
    return [coat[0] + fold, coat[1] + fold, coat[2] + fold];
  }, [X(-106), Y(318), X(106), Y(566)], true);
  c.shape(ellipse(cx, Y(335), 88 * s, 32 * s), coat, [X(-90), Y(300), X(90), Y(370)], true);
  c.shape(rect(X(-12), Y(290), X(12), Y(326)), [150, 112, 92], [X(-12), Y(290), X(12), Y(326)], true);
  c.shape(ellipse(cx, Y(255), 36 * s, 45 * s), [196, 156, 132], [X(-38), Y(208), X(38), Y(302)], true);
  c.shape(ellipse(cx, Y(232), 39 * s, 28 * s), [16, 13, 11], [X(-41), Y(202), X(41), Y(262)], true);
  // Loose hair strands, one pixel wide.
  for (let k = 0; k < 40; k++) {
    const a = -2.7 + r() * 2.4;
    let x0 = cx + 38 * s * Math.cos(a);
    let y0 = Y(240) + 30 * s * Math.sin(a);
    for (let step = 0; step < 6; step++) {
      const x1 = x0 + 3 * s * Math.cos(a) + gauss(r) * s;
      const y1 = y0 + 3 * s * Math.sin(a) + gauss(r) * s;
      c.line(x0, y0, x1, y1, Math.max(1, s), [16, 13, 11], true, 0.85);
      x0 = x1;
      y0 = y1;
    }
  }
}

/**
 * The regression case from the bug report: a person in a dark coat on a
 * dark, rainy street at night, with streetlight glow, lit windows, wet
 * reflections, rain streaks and sensor noise. The coat is within a few
 * levels of the background, so no colour rule can separate them.
 */
export function rainyStreet(width = 640, height = 800, brightness = 1): Scene {
  const r = rng(7);
  const s = height / 800;
  const horizon = height * 0.62;
  const c = new Canvas(width, height, (_x, y) => {
    if (y >= horizon) return [26, 28, 34];
    const t = 1 - y / height;
    return [18 + 14 * t, 22 + 16 * t, 30 + 22 * t];
  });
  for (const [bx, bw, bh] of [[0, 180, 520], [170, 140, 430], [450, 190, 560]] as const) {
    const x0 = bx * (width / 640);
    const x1 = x0 + bw * (width / 640);
    const top = horizon - bh * 0.9 * s;
    c.shape(rect(x0, top, x1, horizon), (x, y) => {
      const o = (y * width + x) * 3;
      return [c.px[o]! * 0.6, c.px[o + 1]! * 0.6, c.px[o + 2]! * 0.6];
    }, [x0, top, x1, horizon]);
    for (let wy = top + 20 * s; wy < horizon - 20 * s; wy += 38 * s) {
      for (let wx = x0 + 12 * s; wx < x1 - 20 * s; wx += 30 * s) {
        if (r() < 0.35) c.shape(rect(wx, wy, wx + 10 * s, wy + 14 * s), [150, 120, 70], [wx, wy, wx + 10 * s, wy + 14 * s]);
      }
    }
  }
  const lights = [[90 * (width / 640), 180 * s], [560 * (width / 640), 150 * s]] as const;
  for (const [lx, ly] of lights) c.shape(rect(lx - 2 * s, ly, lx + 2 * s, horizon), [35, 35, 38], [lx - 2 * s, ly, lx + 2 * s, horizon]);
  c.add((x, y) => {
    let g = 0;
    let refl = 0;
    for (const [lx, ly] of lights) {
      g += Math.exp(-Math.hypot(x - lx, y - ly) / (40 * s)) * 230;
      if (y >= horizon) refl += Math.exp(-Math.abs(x - lx) / (10 * s)) * Math.min(1, ((y - horizon) / height) * 4) * 90 * (0.6 + 0.4 * Math.sin(y / (5 * s)));
    }
    const v = g + refl;
    return [v, v * 0.8, v * 0.45];
  });
  person(c, width * 0.52, s, [24, 24, 28], 11);
  // Rim light on the coat's right edge, from the streetlight.
  c.add((x, y) => {
    const i = y * width + x;
    const d = Math.abs(x - (width * 0.52 + 95 * s));
    const v = c.subject[i]! > 0.5 && y > 320 * s && y < 560 * s && d < 12 * s ? (1 - d / (12 * s)) * 45 : 0;
    return [v, v * 0.8, v * 0.5];
  });
  // Shadow at the feet, then rain streaks.
  c.add((x, y) => {
    const o = (y * width + x) * 3;
    const k = 0.5 * Math.exp(-(((x - width * 0.52) / (120 * s)) ** 2) - ((y - 795 * s) / (14 * s)) ** 2);
    return [-c.px[o]! * k, -c.px[o + 1]! * k, -c.px[o + 2]! * k];
  });
  for (let k = 0; k < 500 * s * s; k++) {
    const x = Math.floor(r() * width);
    const y = Math.floor(r() * (height - 20 * s));
    const len = (8 + r() * 12) * s;
    for (let yy = y; yy < Math.min(height, y + len); yy++) {
      const o = (yy * width + x) * 3;
      for (let ch = 0; ch < 3; ch++) c.px[o + ch] = c.px[o + ch]! + 25;
    }
  }
  if (brightness !== 1) for (let i = 0; i < c.px.length; i++) c.px[i] = c.px[i]! * brightness;
  return c.done(4 * brightness, 3);
}

/** A product shot: a red box with a soft drop shadow on a white backdrop, with mild noise. */
export function productWithShadow(): Scene {
  const c = new Canvas(240, 180, () => [252, 252, 250]);
  // Shadow: darker, same hue as the backdrop, fading out.
  c.add((x, y) => {
    const k = 0.45 * Math.exp(-(((x - 128) / 70) ** 2) - ((y - 152) / 9) ** 2);
    return [-252 * k, -252 * k, -250 * k];
  });
  c.shape(rect(70, 40, 170, 150), [210, 40, 40], [70, 40, 170, 150], true);
  return c.done(1.5, 5);
}

/** A white mug on a black studio backdrop: light subject, dark plain background. */
export function lightOnDark(): Scene {
  const c = new Canvas(200, 160, () => [8, 8, 10]);
  c.shape(ellipse(100, 85, 50, 55), [235, 235, 230], [48, 28, 152, 142], true);
  c.shape(ellipse(158, 85, 18, 24), [235, 235, 230], [138, 59, 178, 111], true);
  return c.done(1.5, 9);
}

/** A charcoal object on a black backdrop: too close in colour for a colour key. */
export function darkOnDark(): Scene {
  const c = new Canvas(200, 160, () => [12, 12, 14]);
  c.shape(rect(60, 30, 140, 160), [34, 34, 38], [60, 30, 140, 160], true);
  return c.done(2, 13);
}

/** Dark wavy hair strands, one pixel wide, around a head on a pale studio backdrop. */
export function hairOnLight(): Scene {
  const c = new Canvas(200, 200, () => [236, 236, 232]);
  const r = rng(21);
  c.shape(ellipse(100, 120, 45, 60), [40, 30, 25], [53, 58, 147, 182], true);
  for (let k = 0; k < 30; k++) {
    const a = -Math.PI + (k / 29) * Math.PI;
    let x0 = 100 + 44 * Math.cos(a);
    let y0 = 120 + 58 * Math.sin(a);
    for (let step = 0; step < 5; step++) {
      const x1 = x0 + 3 * Math.cos(a) + gauss(r) * 0.6;
      const y1 = y0 + 3 * Math.sin(a) + gauss(r) * 0.6;
      c.line(x0, y0, x1, y1, 1, [40, 30, 25], true);
      x0 = x1;
      y0 = y1;
    }
  }
  return c.done(1, 23);
}

/** Score an RGBA result against a scene's ground truth. */
export function score(scene: Scene, rgba: Uint8ClampedArray) {
  let kept = 0;
  let fg = 0;
  let left = 0;
  let bg = 0;
  let inter = 0;
  let union = 0;
  for (let i = 0; i < scene.subject.length; i++) {
    const a = rgba[i * 4 + 3]! / 255;
    const isFg = scene.subject[i]! > 0.5;
    if (isFg) {
      kept += a;
      fg++;
    } else {
      left += a;
      bg++;
    }
    if (isFg && a > 0.5) inter++;
    if (isFg || a > 0.5) union++;
  }
  return { subjectKept: fg ? kept / fg : 0, backgroundLeft: bg ? left / bg : 0, iou: union ? inter / union : 0 };
}
