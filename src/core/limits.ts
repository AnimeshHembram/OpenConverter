/**
 * Resource limits. Canvas size limits differ by browser; iOS Safari is the
 * strictest (about 16.7 megapixels per canvas), so it gets a lower ceiling.
 */

export const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB per file
export const MAX_BATCH_FILES = 200;
export const MAX_DIMENSION = 16_384;

const DESKTOP_MAX_PIXELS = 50_000_000; // ~50 MP
const IOS_MAX_PIXELS = 16_777_216; // 4096 x 4096

export function isIOS(nav: Pick<Navigator, 'userAgent' | 'maxTouchPoints' | 'platform'> = navigator): boolean {
  return /iPad|iPhone|iPod/.test(nav.userAgent) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
}

export function maxPixels(): number {
  return typeof navigator !== 'undefined' && isIOS() ? IOS_MAX_PIXELS : DESKTOP_MAX_PIXELS;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatMegapixels(px: number): string {
  return `${(px / 1_000_000).toFixed(1)} MP`;
}
