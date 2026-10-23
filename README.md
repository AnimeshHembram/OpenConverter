# OpenConvert

Free, open-source file conversion that runs **entirely in your browser**. No account, no uploads, no server, no tracking.

**Phase 1 (current): images.** Convert between PNG, JPEG, WebP and BMP, one file or a whole batch.

## Features

- Pick files, drag and drop them, or paste them from the clipboard
- Detects the real format from the file's bytes, not its name, and warns when the extension is wrong
- Shows name, format, dimensions and size for each file, with before and after previews
- Quality slider for JPEG and WebP
- Handles transparency: kept for PNG, WebP and BMP (32-bit), and filled with a colour you choose for JPEG
- Batch conversion with progress, cancel, and "Download all" as a ZIP
- Checks every output's bytes before offering it, so a file is never mislabelled
- Size limits and one-at-a-time processing to keep memory use low. Every temporary object URL is released when it's no longer needed.

## Privacy

Conversion uses the browser's own APIs (`createImageBitmap`, Canvas, `Blob`). The production build ships a Content-Security-Policy with `connect-src 'self'`, so the browser itself blocks requests to any other site. The automated tests check that no request goes to another origin during conversion.

## Browser support

| Capability | How |
|---|---|
| PNG / JPEG output | Native canvas encoder (all modern browsers) |
| WebP output | Native where available (Chrome, Edge, Firefox). Safari has no native WebP encoder, so OpenConvert loads its own: [libwebp compiled to WebAssembly](https://github.com/jamsinclair/jSquash) (Apache-2.0). It still runs on your device and is only downloaded when needed. |
| BMP output | Built-in TypeScript encoder (no browser can write BMP natively) |
| BMP input | Built-in decoder for consistent alpha handling, with the browser as a fallback for rare variants |

Encoders are detected at startup by checking what the browser actually produces, not by sniffing the user agent. iOS gets a lower pixel limit (16.7 MP) because of Safari's canvas limits. Elsewhere the limit is 50 MP, plus 16,384 px per side and 100 MB per file.

## Development

Requires Node 20 or newer.

```bash
npm install
npm run dev          # local dev server
npm test             # unit tests (Vitest)
npm run build        # type-check + production build into dist/
npm run test:e2e     # real conversions in Chromium, desktop and mobile (builds must exist)
npm run test:all     # everything
```

First run of the end-to-end tests: `npx playwright install chromium`.

Debug hook: add `?noNative=webp` to the URL to force the WebAssembly WebP encoder in any browser.

## Deploying to GitHub Pages

1. Push this folder to a GitHub repository (e.g. `OpenConvert`) on the `main` branch.
2. In the repository, go to **Settings → Pages → Build and deployment** and set **Source** to **GitHub Actions**.
3. Every push to `main` runs all tests and, if they pass, publishes the site to `https://<username>.github.io/<repo>/`.

The workflow sets the base path from the repository name automatically.

## Project structure

```
src/
  core/            format registry, detection, validation, limits, errors, zip, object URLs
  modules/image/   image converter: decode, encode, capabilities, BMP codec
  app/             controller: application state and actions (no DOM styling)
  ui/              plain-DOM view; replaceable without touching conversion logic
  styles.css       placeholder theme built from CSS custom properties
tests/unit/        Vitest
tests/e2e/         Playwright
docs/ARCHITECTURE.md
```

## License

[MIT](LICENSE). Third-party: `@jsquash/webp` (Apache-2.0).
