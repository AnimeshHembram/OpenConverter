/**
 * Detects what this browser can actually encode. `canvas.toBlob` silently
 * falls back to PNG for MIME types it cannot produce (Safari does this for
 * WebP), so the returned blob's type is checked rather than trusted.
 */

export type EncoderKind = 'native' | 'wasm' | 'js';

export interface ImageCapabilities {
  /** Output format id -> how it will be encoded. Missing = unavailable. */
  encoders: Map<string, EncoderKind>;
}

const NATIVE_CANDIDATES: readonly [string, string][] = [
  ['png', 'image/png'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
];

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob(resolve, mime, quality);
    } catch {
      resolve(null);
    }
  });
}

export async function probeNativeEncoder(mime: string): Promise<boolean> {
  const c = document.createElement('canvas');
  c.width = c.height = 2;
  const g = c.getContext('2d');
  if (!g) return false;
  g.fillStyle = 'rgba(255,0,0,0.5)';
  g.fillRect(0, 0, 1, 1);
  const blob = await canvasToBlob(c, mime, 0.9);
  c.width = c.height = 0;
  return !!blob && blob.type === mime && blob.size > 0;
}

export function wasmAvailable(): boolean {
  return typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function';
}

let cached: Promise<ImageCapabilities> | null = null;

/**
 * @param forceDisable  Test/debug hook: pretend these native encoders are
 *   missing (e.g. `?noNative=webp`) to exercise fallbacks in any browser.
 */
export function detectImageCapabilities(forceDisable: readonly string[] = []): Promise<ImageCapabilities> {
  if (cached) return cached;
  cached = (async () => {
    const encoders = new Map<string, EncoderKind>();
    for (const [id, mime] of NATIVE_CANDIDATES) {
      if (!forceDisable.includes(id) && (await probeNativeEncoder(mime))) encoders.set(id, 'native');
    }
    if (!encoders.has('webp') && wasmAvailable()) encoders.set('webp', 'wasm');
    encoders.set('bmp', 'js');
    return { encoders };
  })();
  return cached;
}

export { canvasToBlob };
