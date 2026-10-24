/**
 * "Compress to under N KB": find the highest quality whose output fits the
 * size limit, by binary search over the encoder's quality setting. Encoders
 * are injected so this is unit-tested without a browser.
 */
import { throwIfAborted } from '../../core/errors';

export interface FitResult {
  blob: Blob;
  /** Quality (0..1) of the returned blob. */
  quality: number;
  /** False when even the lowest quality is over the limit (the smallest result is returned). */
  fits: boolean;
}

/** Lowest quality tried. Below this, JPEG and WebP turn to mush for little gain. */
export const MIN_QUALITY = 0.02;
const STEPS = 7;

export async function fitToSize(
  encode: (quality: number) => Promise<Blob>,
  maxBytes: number,
  startQuality: number,
  signal?: AbortSignal,
): Promise<FitResult> {
  const first = await encode(startQuality);
  if (first.size <= maxBytes) return { blob: first, quality: startQuality, fits: true };

  let smallest: FitResult = { blob: first, quality: startQuality, fits: false };
  let best: FitResult | null = null;
  let lo = MIN_QUALITY;
  let hi = startQuality;
  const attempt = async (q: number) => {
    if (signal) throwIfAborted(signal);
    const blob = await encode(q);
    if (blob.size < smallest.blob.size) smallest = { blob, quality: q, fits: false };
    return blob;
  };

  // Check the floor first: if even that doesn't fit, stop early.
  const floor = await attempt(lo);
  if (floor.size > maxBytes) return smallest;
  best = { blob: floor, quality: lo, fits: true };

  for (let i = 0; i < STEPS && hi - lo > 0.01; i++) {
    const mid = Math.round(((lo + hi) / 2) * 1000) / 1000;
    const blob = await attempt(mid);
    if (blob.size <= maxBytes) {
      best = { blob, quality: mid, fits: true };
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return best;
}

/** Parse a size like "500", "500 KB", "1.5MB". Returns bytes, or null for empty/invalid input. */
export function parseSize(value: string, unit: 'KB' | 'MB' = 'KB'): number | null {
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*(kb|mb|k|m)?\s*$/i.exec(value);
  if (!m) return null;
  const n = Number(m[1]!.replace(',', '.'));
  if (!(n > 0)) return null;
  const u = (m[2] ?? unit).toUpperCase().startsWith('M') ? 1024 * 1024 : 1024;
  return Math.round(n * u);
}
