# OpenConverter

Free, open-source file conversion that runs **entirely in your browser**. No account, no uploads, no server, no tracking.

**Current scope: images.** Convert between PNG, JPEG, WebP and BMP, one file or a batch. Document conversion is planned (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#phase-2-boundaries)).

Live site (once GitHub Pages is enabled): `https://animeshhembram.github.io/OpenConverter/`

## Features

- Add files by clicking the upload area, dragging and dropping them anywhere on the page, or pasting.
- Light and dark themes: follows your system until you choose, then remembers your choice.
- A large before/after preview for each file, with format, dimensions and size, and a download button.
- The real format is detected from the file's bytes, not its name. A wrong extension gets a warning.
- Each file shows its name, format, dimensions (as displayed, after photo rotation) and size, with before and after previews.
- Quality setting for JPEG and WebP. A background colour fills transparent areas when converting to JPEG.
- Batch conversion with progress, cancel and per-file remove. "Download all" gives a ZIP with unique file names.
- Every output is checked before it's offered: it must be non-empty, have the right file signature, the right MIME type and a matching extension. A browser that silently produces the wrong format gets an error instead of a mislabelled file.

## Format behaviour and known limitations

| Topic | Behaviour |
|---|---|
| **Transparency** | Kept in PNG and WebP. Kept in BMP by writing a 32-bit BMP (some older apps show transparent areas as black, and the app says so). JPEG can't store transparency, so transparent areas are filled with the chosen colour and the app says so. Transparency is detected at full resolution, so thin features aren't missed. |
| **Animation** | Animated PNG (APNG) and animated WebP are detected from their headers and **only the first frame is converted**. A note says this before conversion. Animated output isn't supported. If a file's header can't be read far enough to tell, no claim is made either way. GIF isn't supported yet. |
| **Photo rotation (EXIF)** | Rotated JPEGs are shown and converted the right way up, and the displayed size accounts for rotation. If a browser ever ignores the rotation, the app warns that the result may be sideways. |
| **Metadata** | Conversion goes through a canvas, so EXIF (including GPS location), colour profiles and other metadata are **not** copied to the output. Images in wide-gamut colour spaces are converted to sRGB. |
| **Other inputs** | GIF, HEIC/HEIF, AVIF, TIFF, ICO, SVG and PDF are recognised and rejected with a clear message. |

## Limits

| Limit | Value | Why |
|---|---|---|
| File size | 100 MB per file | Keeps reading and decoding bounded. |
| Batch size | 200 files at a time | Keeps the list and memory manageable. Extra files are skipped with a message. |
| Side length | 16,384 px | Common browser canvas limit. |
| Pixels: desktop | 50 MP | Peak memory is roughly 12–16 bytes per pixel during conversion (600–800 MB at 50 MP). |
| Pixels: phones and tablets | 24 MP | Mobile browsers give each tab much less memory. Detected from several signals: user agent, client hints, touch with a small screen. |
| Pixels: devices reporting ≤ 4 GB / ≤ 2 GB RAM | 24 MP / 12 MP | Uses `navigator.deviceMemory` where the browser provides it (Chromium). |
| Pixels: iPhone / iPad | 16.7 MP | Safari's canvas area limit. |

Images over the limit are rejected from their header **before** decoding, with an explanation. These limits reduce the risk of the tab running out of memory, but they **can't guarantee it**: browsers don't report how much memory a tab may actually use.

## Browser support

| Capability | How |
|---|---|
| PNG and JPEG output | Native canvas encoder (all modern browsers). |
| WebP output | Native where available (Chrome, Edge, Firefox). Safari has no native WebP encoder, so OpenConverter loads its own, [libwebp compiled to WebAssembly](https://github.com/jamsinclair/jSquash). It runs on your device and is only downloaded from this site when needed. If it can't load, the user gets a specific error with alternatives. |
| BMP output | Built-in TypeScript encoder (no browser can write BMP natively). |
| BMP input | Built-in decoder for consistent transparency, with the browser as a fallback for rare variants (RLE). |

Encoders are detected at startup by checking what the browser actually produces, not by its name.

**Tested automatically:** Chromium (desktop, and Pixel 7 emulation). Firefox, WebKit and iPhone (WebKit) emulation are configured as CI test projects but haven't been run yet; the first CI run will be their first run. See [Testing](#testing) for what still needs a real device.

## Privacy and security

These claims apply to the production site:

- Images are processed in the browser and are never uploaded. There is no backend, analytics, tracking, cookies or account.
- The page carries a Content-Security-Policy with `connect-src 'self'`. The browser blocks any request to another site, and a test checks this. GitHub Pages can't send custom headers, so the policy is a `<meta>` tag. That means `frame-ancestors` (clickjacking protection) can't be set.
- The only network requests are to this site itself: the page, its scripts and styles, and, when needed, the WebP encoder file. The browser tests check that conversions make no request to any other origin.
- `Referrer-Policy: no-referrer` is set for links that leave the site.

## Development

Requires Node 20 or newer (CI uses Node 22).

```bash
npm ci                       # clean install from the lockfile
npm run dev                  # dev server
npm run typecheck
npm test                     # unit tests (Vitest)
npm run build                # production build at "/" into dist/
npm run build:pages          # production build at /OpenConverter/ into dist-pages/
npx playwright install       # once: browsers for the end-to-end tests
npm run test:e2e             # browser tests against dist/ (all projects)
npm run test:e2e:pages       # browser tests against dist-pages/ served at its subpath
npm run test:all             # everything above, in order
npm run test:all:chromium    # same, Chromium only (faster locally)
npm run fixtures             # regenerate binary test fixtures (APNG, animated WebP, rotated JPEG)
```

Debug hook: add `?noNative=webp` to the URL to force the WebAssembly WebP encoder in any browser.

## Testing

- **Unit tests** cover format detection, header parsing (dimensions, animation, EXIF), the BMP codec, ZIP output, file names, limits and their boundaries, device-limit selection, output verification, error messages, and controller lifecycle (cancel, remove, clear, failures part-way through a batch, stale results).
- **Browser tests** run real conversions through the UI and check downloaded bytes and pixels. They cover the thin-transparency regressions, animation warnings, rotated photos, WebP encoder failure and retry, cancel and remove during conversion, release of bitmaps and canvases, back/forward-cache restore, keyboard access and focus, drag-and-drop, paste, ZIP naming and the size-limit messages.
- **Interface tests** cover the theme (system default, switching, persistence, no flash of the wrong theme, blocked storage), the upload zone's states, the preview dialog (keyboard, focus return, uncropped images), the pinned action bar, and a WCAG AA contrast check of every visible piece of text in both themes.
- **GitHub Pages suite** builds with the deployed base path and serves it like GitHub Pages. It checks asset paths, native conversion and the forced WebAssembly WebP encoder, the security policy, footer links, and that no request leaves the site.

**Manual checks that automation can't replace:** real iPhone/iPad Safari (WebKit on Linux is only an approximation), real Android Chrome on a low-memory phone, macOS Safari, a real back/forward navigation (Playwright's Chromium disables the back/forward cache), the native file picker and drag-and-drop from the desktop, screen reader announcements (VoiceOver, NVDA, TalkBack), and very large images near the limits.

## Deploying to GitHub Pages

The workflow in `.github/workflows/deploy.yml`:

- **Pull requests:** typecheck, unit tests, browser tests in Chromium, Firefox and WebKit, then the subpath build and its tests. Never deploys. A newer push to the same pull request cancels its older run.
- **Push to `main` (or a manual run on `main`):** the same tests, then deploys **the exact `dist-pages/` build those tests checked**. Runs on `main` are queued, never cancelled, and pull-request runs can't cancel them.
- **Permissions:** `contents: read` everywhere. Only the deploy job gets `pages: write` and `id-token: write`. No secrets are needed.

One-time setup in the repository: **Settings → Pages → Build and deployment → Source: GitHub Actions.**

The site is served at `/<repository-name>/`. The workflow sets this from the repository name, and the footer's source link comes from `GITHUB_REPOSITORY`, so forks work without changes.

## Project structure

```
src/
  core/            formats, detection, validation, limits, errors, registry, zip, object URLs
  modules/image/   image converter: decode, encode, capabilities, BMP codec
  app/             controller: state, queue, cancellation, downloads (no DOM styling)
  ui/              view.ts (plain-DOM interface) and theme.ts (light/dark switch)
  styles.css       monochrome design: every colour is a token, each theme defined once
public/            theme-init.js: applies the theme before first paint
scripts/           build-pages.mjs, serve-pages.mjs (GitHub Pages emulation)
tests/unit/        Vitest
tests/e2e/         Playwright, root build
tests/e2e-pages/   Playwright, GitHub Pages build at its subpath
tests/fixtures/    binary fixtures and their generator
docs/ARCHITECTURE.md
```

## License

[MIT](LICENSE).

The published site includes third-party code: `@jsquash/webp` (Apache-2.0), libwebp (BSD-3-Clause) and `wasm-feature-detect` (Apache-2.0). Their licence texts are generated into `THIRD_PARTY_NOTICES.txt` at build time and linked from the site footer.
