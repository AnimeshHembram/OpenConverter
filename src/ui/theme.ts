/**
 * Light/dark theme. The theme is applied as `data-theme` on <html>, and all
 * colours come from CSS custom properties keyed off that attribute, so there
 * is exactly one place each theme is defined (styles.css).
 *
 * public/theme-init.js applies the same choice synchronously before first
 * paint (no flash of the wrong theme). It must use the same storage key and
 * rules as `resolveTheme` below.
 */

export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'openconverter-theme';

/** A saved choice wins; otherwise follow the operating system. */
export function resolveTheme(stored: string | null, systemPrefersDark: boolean): Theme {
  if (stored === 'light' || stored === 'dark') return stored;
  return systemPrefersDark ? 'dark' : 'light';
}

/** Storage can be unavailable (private mode, blocked site data): never throw. */
export function readStoredTheme(storage: Pick<Storage, 'getItem'> | undefined): string | null {
  try {
    return storage?.getItem(THEME_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function writeStoredTheme(storage: Pick<Storage, 'setItem'> | undefined, theme: Theme): boolean {
  try {
    storage?.setItem(THEME_STORAGE_KEY, theme);
    return !!storage;
  } catch {
    return false;
  }
}

function safeLocalStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** Background colour of each theme, for the browser's own UI (theme-color). */
export const THEME_BACKGROUND: Record<Theme, string> = { light: '#ffffff', dark: '#0a0a0a' };

export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = theme;
  // Match the mobile browser bar to the chosen theme, not just the system's.
  for (const meta of root.ownerDocument.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = THEME_BACKGROUND[theme];
  }
}

export function currentTheme(root: HTMLElement = document.documentElement): Theme {
  return root.dataset.theme === 'dark' ? 'dark' : 'light';
}

/**
 * Wire up the theme switch: a <button role="switch"> whose `aria-checked`
 * means "dark theme on". Until the user makes a choice, the page follows
 * the operating system, including live changes.
 */
export function initThemeSwitch(button: HTMLButtonElement): void {
  const storage = safeLocalStorage();
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  let userChose = readStoredTheme(storage) !== null;

  const sync = () => {
    const dark = currentTheme() === 'dark';
    button.setAttribute('aria-checked', String(dark));
    button.title = dark ? 'Switch to light theme' : 'Switch to dark theme';
  };

  // Resolve now in case theme-init.js didn't run; re-applying is harmless.
  applyTheme(document.documentElement.dataset.theme === 'dark' || document.documentElement.dataset.theme === 'light'
    ? (document.documentElement.dataset.theme as Theme)
    : resolveTheme(readStoredTheme(storage), media?.matches ?? false));
  sync();

  button.addEventListener('click', () => {
    const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    userChose = true;
    writeStoredTheme(storage, next);
    sync();
  });

  media?.addEventListener?.('change', (e) => {
    if (userChose) return;
    applyTheme(e.matches ? 'dark' : 'light');
    sync();
  });
}
