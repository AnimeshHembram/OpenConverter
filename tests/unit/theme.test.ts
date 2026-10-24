import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { THEME_STORAGE_KEY, readStoredTheme, resolveTheme, writeStoredTheme } from '../../src/ui/theme';

describe('theme selection', () => {
  it('a saved choice wins over the system preference', () => {
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
  });

  it('without a valid saved choice, follows the system', () => {
    expect(resolveTheme(null, true)).toBe('dark');
    expect(resolveTheme(null, false)).toBe('light');
    expect(resolveTheme('purple', true)).toBe('dark');
  });

  it('never throws when storage is unavailable or blocked', () => {
    const throwing = {
      getItem: () => { throw new DOMException('blocked', 'SecurityError'); },
      setItem: () => { throw new DOMException('quota', 'QuotaExceededError'); },
    };
    expect(readStoredTheme(throwing)).toBeNull();
    expect(writeStoredTheme(throwing, 'dark')).toBe(false);
    expect(readStoredTheme(undefined)).toBeNull();
    expect(writeStoredTheme(undefined, 'dark')).toBe(false);
  });

  it('round-trips through storage under one key', () => {
    const map = new Map<string, string>();
    const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
    expect(writeStoredTheme(storage, 'dark')).toBe(true);
    expect(map.get(THEME_STORAGE_KEY)).toBe('dark');
    expect(readStoredTheme(storage)).toBe('dark');
  });

  it('the pre-paint script uses the same storage key', () => {
    const script = readFileSync(new URL('../../public/theme-init.js', import.meta.url), 'utf8');
    expect(script).toContain(`'${THEME_STORAGE_KEY}'`);
  });
});
