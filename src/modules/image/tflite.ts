/**
 * A small, dependency-free TensorFlow Lite interpreter for the one model
 * OpenConverter ships: Google's MediaPipe selfie segmentation model
 * (Apache-2.0, ~250 KB). It supports exactly the float32 operations that
 * model uses, on batch-1 NHWC tensors, and refuses anything else with a
 * clear error rather than guessing.
 *
 * Why not a general runtime? The MediaPipe and ONNX web runtimes are 2–4 MB
 * of compressed WebAssembly, and MediaPipe's needs WebGL. This model is tiny,
 * so plain TypeScript runs it in a fraction of a second, in every browser
 * and in Node (where the unit tests check it against Google's reference
 * interpreter).
 */

// ---- Minimal FlatBuffers reader (just what the TFLite schema needs) ----

class Fb {
  readonly view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u8 = (p: number) => this.view.getUint8(p);
  u16 = (p: number) => this.view.getUint16(p, true);
  i32 = (p: number) => this.view.getInt32(p, true);
  u32 = (p: number) => this.view.getUint32(p, true);
  /** Absolute position of field `index` of the table at `t`, or 0 if absent. */
  field(t: number, index: number): number {
    const vt = t - this.i32(t);
    const at = 4 + index * 2;
    if (at >= this.u16(vt)) return 0;
    const off = this.u16(vt + at);
    return off ? t + off : 0;
  }
  /** Follow an offset (table, vector or string) stored at `p`. */
  deref(p: number): number {
    return p + this.u32(p);
  }
  table(t: number, index: number): number {
    const p = this.field(t, index);
    return p ? this.deref(p) : 0;
  }
  int(t: number, index: number, fallback = 0): number {
    const p = this.field(t, index);
    return p ? this.i32(p) : fallback;
  }
  byte(t: number, index: number, fallback = 0): number {
    const p = this.field(t, index);
    return p ? this.u8(p) : fallback;
  }
  bool(t: number, index: number): boolean {
    return this.byte(t, index) !== 0;
  }
  /** [start, length] of a vector field, or null. */
  vector(t: number, index: number): [number, number] | null {
    const p = this.field(t, index);
    if (!p) return null;
    const v = this.deref(p);
    return [v + 4, this.u32(v)];
  }
  ints(t: number, index: number): number[] {
    const v = this.vector(t, index);
    if (!v) return [];
    return Array.from({ length: v[1] }, (_, i) => this.i32(v[0] + i * 4));
  }
  tables(t: number, index: number): number[] {
    const v = this.vector(t, index);
    if (!v) return [];
    return Array.from({ length: v[1] }, (_, i) => this.deref(v[0] + i * 4));
  }
  bytesOf(t: number, index: number): Uint8Array | null {
    const v = this.vector(t, index);
    return v ? this.bytes.subarray(v[0], v[0] + v[1]) : null;
  }
  string(t: number, index: number): string {
    const b = this.bytesOf(t, index);
    return b ? new TextDecoder().decode(b) : '';
  }
}

// ---- Schema constants (tensorflow/lite/schema/schema.fbs) ----

const enum Op {
  ADD = 0,
  AVERAGE_POOL_2D = 1,
  CONV_2D = 3,
  DEPTHWISE_CONV_2D = 4,
  DEQUANTIZE = 6,
  LOGISTIC = 14,
  MUL = 18,
  RELU = 19,
  RESIZE_BILINEAR = 23,
  CUSTOM = 32,
  HARD_SWISH = 117,
}
const enum DType {
  FLOAT32 = 0,
  FLOAT16 = 1,
  INT32 = 2,
}
/** Fused activation functions. */
const enum Act {
  NONE = 0,
  RELU = 1,
  RELU_N1_TO_1 = 2,
  RELU6 = 3,
}

export class ModelError extends Error {}

interface TensorInfo {
  shape: number[];
  type: number;
  /** Constant data (weights, sizes), or null for activations. */
  data: Float32Array | Int32Array | null;
}

type Kernel = (values: (Float32Array | Int32Array | null)[], y: Float32Array) => void;

function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * f * 2 ** -24;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
}

function activate(out: Float32Array, act: number): void {
  if (act === Act.NONE) return;
  const lo = act === Act.RELU_N1_TO_1 ? -1 : 0;
  const hi = act === Act.RELU6 ? 6 : act === Act.RELU_N1_TO_1 ? 1 : Infinity;
  if (act !== Act.RELU && act !== Act.RELU6 && act !== Act.RELU_N1_TO_1) throw new ModelError(`Unsupported activation ${act}`);
  for (let i = 0; i < out.length; i++) {
    const v = out[i]!;
    out[i] = v < lo ? lo : v > hi ? hi : v;
  }
}

/** TensorFlow "SAME" padding before the first element. */
function padBefore(same: boolean, inSize: number, outSize: number, k: number, stride: number, dil: number): number {
  if (!same) return 0;
  const effective = (k - 1) * dil + 1;
  return Math.max(0, (outSize - 1) * stride + effective - inSize) >> 1;
}

const size = (shape: number[]) => shape.reduce((a, b) => a * b, 1);
/** NHWC dims of a 4-D batch-1 shape (lower ranks are padded with 1s at the front). */
function nhwc(shape: number[]): [number, number, number] {
  const s = [1, 1, 1, 1, ...shape].slice(-4);
  if (s[0] !== 1) throw new ModelError('Only batch size 1 is supported');
  return [s[1]!, s[2]!, s[3]!];
}

export interface TfliteModel {
  inputShape: number[];
  outputShape: number[];
  /** Run the model on one float32 input (NHWC, batch 1) and return the output. */
  run(input: Float32Array): Float32Array;
}

/** Parse a .tflite file and prepare it for execution. Throws ModelError if it uses anything unsupported. */
export function loadTflite(bytes: Uint8Array): TfliteModel {
  if (bytes.length < 8 || new TextDecoder().decode(bytes.subarray(4, 8)) !== 'TFL3') {
    throw new ModelError('Not a TensorFlow Lite model');
  }
  const fb = new Fb(bytes);
  const model = fb.deref(0);
  const opcodes = fb.tables(model, 1).map((c) => ({
    // builtin_code (field 3) replaced deprecated_builtin_code (field 0) for codes > 127.
    code: Math.max(fb.byte(c, 0), fb.int(c, 3)),
    custom: fb.string(c, 1),
  }));
  const buffers = fb.tables(model, 4);
  const subgraphs = fb.tables(model, 2);
  if (subgraphs.length !== 1) throw new ModelError('Expected exactly one subgraph');
  const g = subgraphs[0]!;

  const tensors: TensorInfo[] = fb.tables(g, 0).map((t) => {
    const shape = fb.ints(t, 0);
    const type = fb.byte(t, 1);
    const raw = buffers[fb.int(t, 2)] !== undefined ? fb.bytesOf(buffers[fb.int(t, 2)]!, 0) : null;
    let data: TensorInfo['data'] = null;
    if (raw && raw.length) {
      const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      const n = size(shape);
      if (type === DType.FLOAT32) data = Float32Array.from({ length: n }, (_, i) => dv.getFloat32(i * 4, true));
      else if (type === DType.FLOAT16) data = Float32Array.from({ length: n }, (_, i) => halfToFloat(dv.getUint16(i * 2, true)));
      else if (type === DType.INT32) data = Int32Array.from({ length: n }, (_, i) => dv.getInt32(i * 4, true));
      else throw new ModelError(`Unsupported constant tensor type ${type}`);
    } else if (type !== DType.FLOAT32) {
      throw new ModelError(`Unsupported activation tensor type ${type}`);
    }
    return { shape, type, data };
  });
  const inputs = fb.ints(g, 1);
  const outputs = fb.ints(g, 2);
  if (inputs.length !== 1 || outputs.length !== 1) throw new ModelError('Expected one input and one output');

  const f32 = (i: number): Float32Array => {
    const d = tensors[i]?.data;
    if (!(d instanceof Float32Array)) throw new ModelError(`Tensor ${i} must be constant float data`);
    return d;
  };

  const steps: { ins: number[]; out: number; kernel: Kernel }[] = [];
  for (const o of fb.tables(g, 3)) {
    const { code, custom } = opcodes[fb.int(o, 0)] ?? { code: -1, custom: '' };
    const ins = fb.ints(o, 1);
    const outs = fb.ints(o, 2);
    if (outs.length !== 1) throw new ModelError('Operators with several outputs are not supported');
    const out = outs[0]!;
    const opts = fb.table(o, 4);
    const outShape = tensors[out]!.shape;

    if (code === Op.DEQUANTIZE) {
      // fp16 weights -> float32, done once at load time.
      const src = tensors[ins[0]!]!;
      if (!(src.data instanceof Float32Array)) throw new ModelError('DEQUANTIZE of a non-constant tensor');
      tensors[out]!.data = src.data;
      continue;
    }

    let kernel: Kernel;
    switch (code) {
      case Op.CONV_2D: {
        const same = fb.byte(opts, 0) === 0;
        const [sw, sh, act] = [fb.int(opts, 1, 1), fb.int(opts, 2, 1), fb.byte(opts, 3)];
        const [dw, dh] = [fb.int(opts, 4, 1), fb.int(opts, 5, 1)];
        const w = f32(ins[1]!);
        const b = ins[2] !== undefined && ins[2] >= 0 ? f32(ins[2]) : null;
        const [H, W, C] = nhwc(tensors[ins[0]!]!.shape);
        const [O, kh, kw, Ci] = tensors[ins[1]!]!.shape as [number, number, number, number];
        const [OH, OW] = nhwc(outShape);
        if (Ci !== C) throw new ModelError('CONV_2D channel mismatch');
        const pt = padBefore(same, H, OH, kh, sh, dh);
        const pl = padBefore(same, W, OW, kw, sw, dw);
        const pointwise = kh === 1 && kw === 1 && sh === 1 && sw === 1 && H === OH && W === OW;
        kernel = (v, y) => {
          const x = v[0] as Float32Array;
          if (pointwise) {
            for (let p = 0; p < H * W; p++) {
              const xo = p * C;
              const yo = p * O;
              for (let o2 = 0; o2 < O; o2++) {
                let s = b ? b[o2]! : 0;
                const wo = o2 * C;
                for (let c = 0; c < C; c++) s += x[xo + c]! * w[wo + c]!;
                y[yo + o2] = s;
              }
            }
          } else {
            for (let oy = 0; oy < OH; oy++) {
              for (let ox = 0; ox < OW; ox++) {
                const yo = (oy * OW + ox) * O;
                for (let o2 = 0; o2 < O; o2++) {
                  let s = b ? b[o2]! : 0;
                  for (let ky = 0; ky < kh; ky++) {
                    const iy = oy * sh + ky * dh - pt;
                    if (iy < 0 || iy >= H) continue;
                    for (let kx = 0; kx < kw; kx++) {
                      const ix = ox * sw + kx * dw - pl;
                      if (ix < 0 || ix >= W) continue;
                      const xo = (iy * W + ix) * C;
                      const wo = ((o2 * kh + ky) * kw + kx) * C;
                      for (let c = 0; c < C; c++) s += x[xo + c]! * w[wo + c]!;
                    }
                  }
                  y[yo + o2] = s;
                }
              }
            }
          }
          activate(y, act);
        };
        break;
      }
      case Op.DEPTHWISE_CONV_2D: {
        const same = fb.byte(opts, 0) === 0;
        const [sw, sh, mult, act] = [fb.int(opts, 1, 1), fb.int(opts, 2, 1), fb.int(opts, 3, 1), fb.byte(opts, 4)];
        const [dw, dh] = [fb.int(opts, 5, 1), fb.int(opts, 6, 1)];
        const w = f32(ins[1]!);
        const b = ins[2] !== undefined && ins[2] >= 0 ? f32(ins[2]) : null;
        const [H, W, C] = nhwc(tensors[ins[0]!]!.shape);
        const [, kh, kw, CO] = tensors[ins[1]!]!.shape as [number, number, number, number];
        const [OH, OW] = nhwc(outShape);
        if (CO !== C * mult) throw new ModelError('DEPTHWISE_CONV_2D channel mismatch');
        const pt = padBefore(same, H, OH, kh, sh, dh);
        const pl = padBefore(same, W, OW, kw, sw, dw);
        kernel = (v, y) => {
          const x = v[0] as Float32Array;
          for (let oy = 0; oy < OH; oy++) {
            for (let ox = 0; ox < OW; ox++) {
              const yo = (oy * OW + ox) * CO;
              for (let co = 0; co < CO; co++) y[yo + co] = b ? b[co]! : 0;
              for (let ky = 0; ky < kh; ky++) {
                const iy = oy * sh + ky * dh - pt;
                if (iy < 0 || iy >= H) continue;
                for (let kx = 0; kx < kw; kx++) {
                  const ix = ox * sw + kx * dw - pl;
                  if (ix < 0 || ix >= W) continue;
                  const xo = (iy * W + ix) * C;
                  const wo = (ky * kw + kx) * CO;
                  for (let co = 0; co < CO; co++) y[yo + co] = y[yo + co]! + x[xo + ((co / mult) | 0)]! * w[wo + co]!;
                }
              }
            }
          }
          activate(y, act);
        };
        break;
      }
      case Op.AVERAGE_POOL_2D: {
        const same = fb.byte(opts, 0) === 0;
        const [sw, sh, fw, fh, act] = [fb.int(opts, 1, 1), fb.int(opts, 2, 1), fb.int(opts, 3), fb.int(opts, 4), fb.byte(opts, 5)];
        const [H, W, C] = nhwc(tensors[ins[0]!]!.shape);
        const [OH, OW] = nhwc(outShape);
        const pt = padBefore(same, H, OH, fh, sh, 1);
        const pl = padBefore(same, W, OW, fw, sw, 1);
        kernel = (v, y) => {
          const x = v[0] as Float32Array;
          for (let oy = 0; oy < OH; oy++) {
            for (let ox = 0; ox < OW; ox++) {
              const y0 = Math.max(0, oy * sh - pt);
              const y1 = Math.min(H, oy * sh - pt + fh);
              const x0 = Math.max(0, ox * sw - pl);
              const x1 = Math.min(W, ox * sw - pl + fw);
              const n = Math.max(1, (y1 - y0) * (x1 - x0)); // padding is excluded, as in TFLite
              for (let c = 0; c < C; c++) {
                let s = 0;
                for (let iy = y0; iy < y1; iy++) for (let ix = x0; ix < x1; ix++) s += x[(iy * W + ix) * C + c]!;
                y[(oy * OW + ox) * C + c] = s / n;
              }
            }
          }
          activate(y, act);
        };
        break;
      }
      case Op.ADD:
      case Op.MUL: {
        const act = fb.byte(opts, 0);
        const a = nhwc(tensors[ins[0]!]!.shape);
        const bs = nhwc(tensors[ins[1]!]!.shape);
        const o = nhwc(outShape);
        for (let i = 0; i < 3; i++) {
          if ((a[i] !== o[i] && a[i] !== 1) || (bs[i] !== o[i] && bs[i] !== 1)) throw new ModelError('Unsupported broadcast');
        }
        const mul = code === Op.MUL;
        kernel = (v, y) => {
          const x = v[0] as Float32Array;
          const z = v[1] as Float32Array;
          let i = 0;
          for (let h = 0; h < o[0]; h++) {
            const ah = a[0] === 1 ? 0 : h;
            const bh = bs[0] === 1 ? 0 : h;
            for (let w = 0; w < o[1]; w++) {
              const ao = (ah * a[1] + (a[1] === 1 ? 0 : w)) * a[2];
              const bo = (bh * bs[1] + (bs[1] === 1 ? 0 : w)) * bs[2];
              for (let c = 0; c < o[2]; c++, i++) {
                const p = x[ao + (a[2] === 1 ? 0 : c)]!;
                const q = z[bo + (bs[2] === 1 ? 0 : c)]!;
                y[i] = mul ? p * q : p + q;
              }
            }
          }
          activate(y, act);
        };
        break;
      }
      case Op.RELU:
        kernel = (v, y) => {
          const x = v[0] as Float32Array;
          for (let i = 0; i < x.length; i++) y[i] = x[i]! > 0 ? x[i]! : 0;
        };
        break;
      case Op.HARD_SWISH:
        kernel = (v, y) => {
          const x = v[0] as Float32Array;
          for (let i = 0; i < x.length; i++) {
            const t = x[i]! + 3;
            y[i] = (x[i]! * (t < 0 ? 0 : t > 6 ? 6 : t)) / 6;
          }
        };
        break;
      case Op.LOGISTIC:
        kernel = (v, y) => {
          const x = v[0] as Float32Array;
          for (let i = 0; i < x.length; i++) y[i] = 1 / (1 + Math.exp(-x[i]!));
        };
        break;
      case Op.RESIZE_BILINEAR: {
        const align = fb.bool(opts, 2);
        const half = fb.bool(opts, 3);
        const [H, W, C] = nhwc(tensors[ins[0]!]!.shape);
        const [OH, OW] = nhwc(outShape);
        const scale = (i: number, o: number) => (align && o > 1 ? (i - 1) / (o - 1) : i / o);
        const sy = scale(H, OH);
        const sx = scale(W, OW);
        // Same interpolation as TFLite's reference kernel.
        const axis = (d: number, s: number, n: number) => {
          const v = half ? (d + 0.5) * s - 0.5 : d * s;
          const f = Math.floor(v);
          return { lo: Math.max(f, 0), hi: Math.min(Math.ceil(v), n - 1), t: v - f };
        };
        kernel = (v, y) => {
          const x = v[0] as Float32Array;
          for (let oy = 0; oy < OH; oy++) {
            const ry = axis(oy, sy, H);
            for (let ox = 0; ox < OW; ox++) {
              const rx = axis(ox, sx, W);
              const o00 = (ry.lo * W + rx.lo) * C;
              const o01 = (ry.lo * W + rx.hi) * C;
              const o10 = (ry.hi * W + rx.lo) * C;
              const o11 = (ry.hi * W + rx.hi) * C;
              const yo = (oy * OW + ox) * C;
              for (let c = 0; c < C; c++) {
                y[yo + c] =
                  x[o00 + c]! * (1 - ry.t) * (1 - rx.t) +
                  x[o10 + c]! * ry.t * (1 - rx.t) +
                  x[o01 + c]! * (1 - ry.t) * rx.t +
                  x[o11 + c]! * ry.t * rx.t;
              }
            }
          }
        };
        break;
      }
      case Op.CUSTOM: {
        if (custom !== 'Convolution2DTransposeBias') throw new ModelError(`Unsupported custom operator "${custom}"`);
        // MediaPipe's custom op: options are a raw TfLiteTransposeConvParams
        // struct { int32 padding (1 = SAME, 2 = VALID); int32 stride_w; int32 stride_h }.
        const raw = fb.bytesOf(o, 5);
        if (!raw || raw.length < 12) throw new ModelError('Missing transpose-convolution options');
        const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        const same = dv.getInt32(0, true) === 1;
        const sw = dv.getInt32(4, true);
        const sh = dv.getInt32(8, true);
        const w = f32(ins[1]!);
        const b = f32(ins[2]!);
        const [H, W, C] = nhwc(tensors[ins[0]!]!.shape);
        const [O, kh, kw, Ci] = tensors[ins[1]!]!.shape as [number, number, number, number];
        const [OH, OW] = nhwc(outShape);
        if (Ci !== C) throw new ModelError('Transpose convolution channel mismatch');
        const pt = same ? Math.max(0, (H - 1) * sh + kh - OH) >> 1 : 0;
        const pl = same ? Math.max(0, (W - 1) * sw + kw - OW) >> 1 : 0;
        kernel = (v, y) => {
          const x = v[0] as Float32Array;
          for (let p = 0; p < OH * OW; p++) for (let o2 = 0; o2 < O; o2++) y[p * O + o2] = b[o2]!;
          for (let iy = 0; iy < H; iy++) {
            for (let ix = 0; ix < W; ix++) {
              const xo = (iy * W + ix) * C;
              for (let ky = 0; ky < kh; ky++) {
                const oy = iy * sh + ky - pt;
                if (oy < 0 || oy >= OH) continue;
                for (let kx = 0; kx < kw; kx++) {
                  const ox = ix * sw + kx - pl;
                  if (ox < 0 || ox >= OW) continue;
                  for (let o2 = 0; o2 < O; o2++) {
                    const wo = ((o2 * kh + ky) * kw + kx) * C;
                    let s = 0;
                    for (let c = 0; c < C; c++) s += x[xo + c]! * w[wo + c]!;
                    y[(oy * OW + ox) * O + o2] = y[(oy * OW + ox) * O + o2]! + s;
                  }
                }
              }
            }
          }
        };
        break;
      }
      default:
        throw new ModelError(`Unsupported operator ${code}`);
    }
    steps.push({ ins, out, kernel });
  }

  // Release each activation after its last use so peak memory stays small.
  const lastUse = new Map<number, number>();
  steps.forEach((s, i) => s.ins.forEach((t) => lastUse.set(t, i)));

  const inShape = tensors[inputs[0]!]!.shape;
  const outShape = tensors[outputs[0]!]!.shape;
  return {
    inputShape: inShape,
    outputShape: outShape,
    run(input) {
      if (input.length !== size(inShape)) throw new ModelError('Input has the wrong size');
      const live = new Map<number, Float32Array | Int32Array>([[inputs[0]!, input]]);
      const value = (t: number) => (t < 0 ? null : (tensors[t]!.data ?? live.get(t) ?? null));
      steps.forEach((s, i) => {
        const out = new Float32Array(size(tensors[s.out]!.shape));
        s.kernel(s.ins.map(value), out);
        live.set(s.out, out);
        for (const t of s.ins) if (lastUse.get(t) === i && t !== outputs[0]) live.delete(t);
      });
      const result = live.get(outputs[0]!);
      if (!(result instanceof Float32Array)) throw new ModelError('The model produced no output');
      return result;
    },
  };
}
