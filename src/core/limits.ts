/**
 * Resource limits.
 *
 * Converting an image needs several full-size pixel buffers at once: the
 * decoded image, the canvas, and for BMP or the built-in WebP encoder a copy
 * of the pixels, plus the encoded output. Peak memory is roughly 12–16 bytes
 * per pixel, so a 50 MP photo can need 600–800 MB. That is fine on most
 * desktops but can crash a phone's browser tab, so the pixel limit depends on
 * the device. These limits reduce the risk of running out of memory; they
 * cannot guarantee it never happens, because browsers don't report how much
 * memory a tab may actually use.
 */

export const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB per file
export const MAX_BATCH_FILES = 200;
export const MAX_DIMENSION = 16_384;
/** Text and data files are parsed whole in memory, which needs several times their size. */
export const MAX_TEXT_BYTES = 50 * 1024 * 1024;
/** Spreadsheets expand a lot when loaded (every cell becomes an object). */
export const MAX_SPREADSHEET_BYTES = 25 * 1024 * 1024;

export interface DeviceProfile {
  /** iPhone, iPad (including iPadOS in desktop mode). */
  ios: boolean;
  /** Phone or tablet, from any of several signals. */
  mobile: boolean;
  /** navigator.deviceMemory in GB (Chromium only; capped at 8). */
  deviceMemoryGB?: number;
}

export interface PixelPolicy {
  maxPixels: number;
  /** Plain-language reason, shown when an image is rejected. */
  reason: string;
}

export const PIXEL_LIMITS = {
  ios: 16_777_216, // Safari's canvas area cap (4096 × 4096)
  veryLowMemory: 12_000_000,
  lowMemory: 24_000_000,
  mobile: 24_000_000,
  desktop: 50_000_000,
} as const;

/** Pure policy: the most conservative rule that applies wins. */
export function selectPixelPolicy(p: DeviceProfile): PixelPolicy {
  if (p.ios) {
    return { maxPixels: PIXEL_LIMITS.ios, reason: 'iPhone and iPad browsers limit images to about 16.8 megapixels' };
  }
  if (p.deviceMemoryGB !== undefined && p.deviceMemoryGB <= 2) {
    return { maxPixels: PIXEL_LIMITS.veryLowMemory, reason: 'this device has limited memory' };
  }
  if (p.deviceMemoryGB !== undefined && p.deviceMemoryGB <= 4) {
    return { maxPixels: PIXEL_LIMITS.lowMemory, reason: 'this device has limited memory' };
  }
  if (p.mobile) {
    return { maxPixels: PIXEL_LIMITS.mobile, reason: 'phones and tablets give each browser tab less memory' };
  }
  return { maxPixels: PIXEL_LIMITS.desktop, reason: 'larger images risk running out of memory in the browser' };
}

export interface NavigatorLike {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
  deviceMemory?: number;
  userAgentData?: { mobile?: boolean };
}

export interface EnvLike {
  navigator?: NavigatorLike;
  matchMedia?: (q: string) => { matches: boolean };
  screen?: { width: number; height: number };
}

export function isIOS(nav: NavigatorLike): boolean {
  return /iPad|iPhone|iPod/.test(nav.userAgent) || (nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1);
}

/**
 * Combine several independent signals; any one of them marks the device as
 * mobile, because erring on the side of a lower limit is the safe failure.
 */
export function detectDeviceProfile(env: EnvLike): DeviceProfile {
  const nav = env.navigator;
  if (!nav) return { ios: false, mobile: false };
  const uaMobile = /Android|Mobi|Silk|Kindle/i.test(nav.userAgent);
  const hintMobile = nav.userAgentData?.mobile === true;
  let touchSmallScreen = false;
  try {
    const coarse = env.matchMedia?.('(pointer: coarse)').matches ?? false;
    const shortSide = env.screen ? Math.min(env.screen.width, env.screen.height) : Infinity;
    touchSmallScreen = coarse && shortSide < 820;
  } catch {
    /* matchMedia unavailable */
  }
  const mem = typeof nav.deviceMemory === 'number' && nav.deviceMemory > 0 ? nav.deviceMemory : undefined;
  const ios = isIOS(nav);
  return { ios, mobile: ios || uaMobile || hintMobile || touchSmallScreen, deviceMemoryGB: mem };
}

let cachedPolicy: PixelPolicy | null = null;

export function pixelPolicy(): PixelPolicy {
  cachedPolicy ??= selectPixelPolicy(
    detectDeviceProfile({
      navigator: typeof navigator !== 'undefined' ? (navigator as unknown as NavigatorLike) : undefined,
      matchMedia: typeof matchMedia === 'function' ? (q) => matchMedia(q) : undefined,
      screen: typeof screen !== 'undefined' ? screen : undefined,
    }),
  );
  return cachedPolicy;
}

export function maxPixels(): number {
  return pixelPolicy().maxPixels;
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
