import { describe, expect, it } from 'vitest';
import { ConversionError } from '../../src/core/errors';
import { checkDimensions, inspectFile } from '../../src/core/inspect';
import {
  MAX_DIMENSION,
  MAX_FILE_BYTES,
  PIXEL_LIMITS,
  detectDeviceProfile,
  selectPixelPolicy,
  type EnvLike,
} from '../../src/core/limits';

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const env = (nav: EnvLike['navigator'], opts: { coarse?: boolean; screen?: [number, number] } = {}): EnvLike => ({
  navigator: nav,
  matchMedia: (q) => ({ matches: q === '(pointer: coarse)' && !!opts.coarse }),
  screen: opts.screen ? { width: opts.screen[0], height: opts.screen[1] } : { width: 1920, height: 1080 },
});

describe('pixel policy selection', () => {
  it('uses the desktop limit only when nothing suggests a constrained device', () => {
    expect(selectPixelPolicy({ ios: false, mobile: false }).maxPixels).toBe(PIXEL_LIMITS.desktop);
    expect(selectPixelPolicy({ ios: false, mobile: false, deviceMemoryGB: 8 }).maxPixels).toBe(PIXEL_LIMITS.desktop);
  });

  it('applies the most conservative rule that matches', () => {
    expect(selectPixelPolicy({ ios: true, mobile: true, deviceMemoryGB: 8 }).maxPixels).toBe(PIXEL_LIMITS.ios);
    expect(selectPixelPolicy({ ios: false, mobile: false, deviceMemoryGB: 2 }).maxPixels).toBe(PIXEL_LIMITS.veryLowMemory);
    expect(selectPixelPolicy({ ios: false, mobile: false, deviceMemoryGB: 0.5 }).maxPixels).toBe(PIXEL_LIMITS.veryLowMemory);
    expect(selectPixelPolicy({ ios: false, mobile: false, deviceMemoryGB: 4 }).maxPixels).toBe(PIXEL_LIMITS.lowMemory);
    expect(selectPixelPolicy({ ios: false, mobile: true, deviceMemoryGB: 8 }).maxPixels).toBe(PIXEL_LIMITS.mobile);
    expect(selectPixelPolicy({ ios: false, mobile: true }).maxPixels).toBe(PIXEL_LIMITS.mobile);
  });

  it('keeps every constrained limit below the desktop one', () => {
    for (const k of ['ios', 'veryLowMemory', 'lowMemory', 'mobile'] as const) {
      expect(PIXEL_LIMITS[k]).toBeLessThan(PIXEL_LIMITS.desktop);
    }
  });
});

describe('device detection uses several signals, not only the user agent', () => {
  it('desktop browser', () => {
    expect(detectDeviceProfile(env({ userAgent: DESKTOP_UA, deviceMemory: 8 }))).toEqual({ ios: false, mobile: false, deviceMemoryGB: 8 });
  });

  it('Android by user agent', () => {
    expect(detectDeviceProfile(env({ userAgent: ANDROID_UA })).mobile).toBe(true);
  });

  it('a phone that sends a desktop user agent ("Desktop site") is still caught by client hints or touch + small screen', () => {
    expect(detectDeviceProfile(env({ userAgent: DESKTOP_UA, userAgentData: { mobile: true } })).mobile).toBe(true);
    expect(detectDeviceProfile(env({ userAgent: DESKTOP_UA }, { coarse: true, screen: [412, 915] })).mobile).toBe(true);
  });

  it('a touch laptop with a large screen is not treated as mobile', () => {
    expect(detectDeviceProfile(env({ userAgent: DESKTOP_UA }, { coarse: true, screen: [1920, 1080] })).mobile).toBe(false);
  });

  it('low device memory is picked up from navigator.deviceMemory', () => {
    const p = detectDeviceProfile(env({ userAgent: DESKTOP_UA, deviceMemory: 2 }));
    expect(selectPixelPolicy(p).maxPixels).toBe(PIXEL_LIMITS.veryLowMemory);
  });

  it('iPhone and iPadOS in desktop mode', () => {
    expect(detectDeviceProfile(env({ userAgent: IPHONE_UA })).ios).toBe(true);
    expect(detectDeviceProfile(env({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 5 })).ios).toBe(true);
  });

  it('missing APIs do not throw', () => {
    expect(detectDeviceProfile({})).toEqual({ ios: false, mobile: false });
    expect(detectDeviceProfile({ navigator: { userAgent: DESKTOP_UA } }).mobile).toBe(false);
    const throwing: EnvLike = { navigator: { userAgent: DESKTOP_UA }, matchMedia: () => { throw new Error('no'); } };
    expect(detectDeviceProfile(throwing).mobile).toBe(false);
  });
});

describe('limit boundaries', () => {
  const policy = { maxPixels: 24_000_000, reason: 'phones and tablets give each browser tab less memory' };

  it('pixel count: exactly at the limit passes, one more pixel fails with the reason', () => {
    expect(() => checkDimensions({ width: 6000, height: 4000 }, policy)).not.toThrow();
    expect(() => checkDimensions({ width: 6000, height: 4001 }, policy)).toThrow(ConversionError);
    expect(() => checkDimensions({ width: 6000, height: 4001 }, policy)).toThrow(/24\.0 MP, because phones and tablets/);
  });

  it(`side length: ${MAX_DIMENSION}px passes, ${MAX_DIMENSION + 1}px fails`, () => {
    const big = { maxPixels: Number.MAX_SAFE_INTEGER, reason: 'x' };
    expect(() => checkDimensions({ width: MAX_DIMENSION, height: 10 }, big)).not.toThrow();
    expect(() => checkDimensions({ width: MAX_DIMENSION + 1, height: 10 }, big)).toThrow(/16,384 pixels per side/);
    expect(() => checkDimensions({ width: 10, height: MAX_DIMENSION + 1 }, big)).toThrow(/16,384 pixels per side/);
  });

  it('zero or nonsense dimensions are reported as damaged', () => {
    expect(() => checkDimensions({ width: 0, height: 10 }, policy)).toThrow(/invalid dimensions/);
    expect(() => checkDimensions({ width: NaN, height: 10 }, policy)).toThrow(/invalid dimensions/);
  });

  it('file size: exactly the limit is accepted, one byte more is rejected', async () => {
    const header = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 4, 0, 0, 0, 4]);
    const fake = (size: number) => ({ name: 'big.png', size, slice: () => new Blob([header]) }) as unknown as File;
    await expect(inspectFile(fake(MAX_FILE_BYTES))).resolves.toMatchObject({ format: { id: 'png' } });
    await expect(inspectFile(fake(MAX_FILE_BYTES + 1))).rejects.toThrow(/The limit is 100 MB per file/);
  });
});
