import './styles.css';
import { Controller } from './app/controller';
import { registerConverter } from './core/registry';
import { detectImageCapabilities } from './modules/image/capabilities';
import { createImageConverter } from './modules/image/converter';
import { pixelPolicy } from './core/limits';
import { initThemeSwitch } from './ui/theme';
import { mountApp } from './ui/view';

async function start(): Promise<void> {
  const root = document.getElementById('app')!;
  const themeSwitch = document.getElementById('theme-switch');
  if (themeSwitch instanceof HTMLButtonElement) initThemeSwitch(themeSwitch);
  // Debug/test hook: ?noNative=webp forces the fallback encoder path.
  const params = new URLSearchParams(location.search);
  const forceDisable = (params.get('noNative') ?? '').split(',').filter(Boolean);

  const caps = await detectImageCapabilities(forceDisable);
  registerConverter(createImageConverter(caps));
  // Phase 2: document converters register here, each lazily loading its
  // libraries on first use so the image converter stays fast to load.

  const controller = new Controller({
    target: caps.encoders.has('webp') ? 'webp' : 'jpeg',
    quality: 0.85,
    background: '#ffffff',
  });
  mountApp(root, controller, caps);
  root.removeAttribute('aria-busy');
  // Exposed for automated tests and debugging in the console.
  (window as unknown as { openconvert: unknown }).openconvert = { controller, caps, pixelPolicy: pixelPolicy() };
}

start().catch((e) => {
  console.error(e);
  const root = document.getElementById('app');
  if (root) root.textContent = "OpenConverter couldn't start in this browser. Please try an up-to-date Chrome, Edge, Firefox or Safari.";
});
