import './styles.css';
import { Controller } from './app/controller';
import { registerConverter } from './core/registry';
import { detectImageCapabilities } from './modules/image/capabilities';
import { createImageConverter } from './modules/image/converter';
import type { Segmenter } from './modules/image/segment';
import { createDocumentConverter } from './modules/document/converter';
import { createPdfConverter } from './modules/pdf/converter';
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

  // The standalone build is opened from disk (file://): only what's inlined
  // in the page can load, which excludes the WebAssembly WebP encoder.
  const standalone = location.protocol === 'file:';
  const caps = await detectImageCapabilities(forceDisable, { allowWasm: !standalone });
  // Photo background removal downloads a small model from this site on
  // first use, which a page opened from disk can't do.
  // The interpreter is only loaded when a photo needs it.
  let loadSegmenter: Promise<Segmenter> | null = null;
  const segmenter: Segmenter = {
    async segment(rgba, width, height) {
      loadSegmenter ??= import('./modules/image/segment').then((m) => m.createSegmenter());
      return (await loadSegmenter).segment(rgba, width, height);
    },
  };
  registerConverter(createImageConverter(caps, { segmenter: standalone ? undefined : segmenter }));
  // Documents: text and data. Heavy libraries (Excel) load on first use, and
  // can't load at all from disk, so the standalone file leaves them out.
  registerConverter(createDocumentConverter({ libraries: !standalone }));
  // PDF input: pdf.js runs in a worker and loads data files, none of which
  // can load from disk either.
  registerConverter(createPdfConverter({ available: !standalone }));

  const controller = new Controller({
    target: caps.encoders.has('webp') ? 'webp' : 'jpeg',
    quality: 0.85,
    background: '#ffffff',
    colour: 'original',
    removeBackground: false,
    bgTolerance: 25,
    maxBytes: null,
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
