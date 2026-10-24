# Architecture

## Layers

```
 UI (src/ui)            renders state, forwards user actions; monochrome design
        │ subscribe / call Controller methods
 Controller (src/app)   state, queue, cancellation, downloads, object-URL lifetime
        │ registry lookups
 Core (src/core)        formats, detection, validation, limits, errors, registry, zip
        │ Converter interface (src/core/types.ts)
 Modules (src/modules)  image/ (Phase 1) · document/ (Phase 2) · …
```

**The contract the UI depends on:**
- `Controller`'s public methods: `addFiles`, `remove`, `clear`, `cancel`, `convertAll`, `download`, `downloadAll`, `setSettings`, `downloadableItems`, `subscribe`.
- The `AppState` and `FileItem` shapes.

The UI never imports a conversion module, so a redesign can replace `src/ui/view.ts` and `src/styles.css` completely. Keep the `data-testid` attributes so the browser tests stay valid.

## Interface (src/ui, src/styles.css)

- **Design tokens.** All colours, radii and the control height are CSS custom properties. Light is defined on `:root` and dark on `[data-theme='dark']`, each exactly once. Text greys meet WCAG AA (4.5:1) on every background they appear on; a browser test checks every visible text node in both themes.
- **Theme.** `public/theme-init.js` runs synchronously in `<head>` and sets `data-theme` (saved choice, else the system preference) before first paint. It's a separate file because the CSP forbids inline scripts. `src/ui/theme.ts` wires the header switch (`role="switch"`), saves the choice in `localStorage` (failures ignored), follows live system changes until the user chooses, and keeps `<meta name="theme-color">` in sync. Both files share one storage key; a unit test checks it.
- **Layout states.** `body.has-files` switches between the empty state (large centred drop zone) and the working state (compact zone, settings, list, action bar). The action bar is `position: sticky` inside a container with `overflow: clip`, so it stays on screen in long lists.
- **Preview.** A native modal `<dialog>`: focus moves to Close, Escape or a backdrop click closes it, and focus returns to the opener. It re-renders when the item's result arrives and closes if the file is removed.
- **No fonts or images are fetched.** The type is a system font stack and every icon is inline SVG, so the page makes no third-party requests.

**Modules** register `Converter`s. A converter declares which outputs it can produce for an input *in this browser* (`outputsFor`) and performs one conversion, reporting progress and honouring an `AbortSignal`.

## Image conversion pipeline

1. **`inspectFile`** runs when a file is added. It:
   - checks the file size;
   - sniffs the magic bytes;
   - reads dimensions from the header and applies EXIF orientation;
   - detects animation (an APNG `acTL` chunk, or the WebP `VP8X` animation flag);
   - checks the device pixel limit **before decoding**, which rejects decompression bombs early;
   - warns about a misleading extension or an animated input.
2. **`decodeImage`** uses the JS BMP decoder for BMP. Otherwise it uses `createImageBitmap` with EXIF orientation applied, falling back to `<img>.decode()`.
3. **Transparency**, where correctness matters:
   - Formats without alpha (JPEG) **always** get the background painted behind the image with `destination-over`. This leaves opaque pixels unchanged, so correctness never depends on detecting transparency first.
   - Whether the image had transparency is computed **at full resolution**. For JPEG this is a strip-wise scan, only for inputs that can carry alpha, and it drives the warning. For BMP and the WASM WebP encoder it comes from the exact pixel array the encoder uses, and it decides 24-bit or 32-bit BMP.
   - An earlier version used a 256-pixel downscaled probe, which missed thin features. Downscaled probes must not be used for correctness decisions.
4. **Encode** with one of three encoders:
   - native `canvas.toBlob` for PNG and JPEG, and WebP where supported;
   - the lazy-loaded WASM WebP encoder;
   - the JS BMP encoder.

   WASM *load* failures and *encode* failures give different, actionable messages, and a failed load can be retried.
5. **`verifyOutput`** checks every encoder path: the output is non-empty, the sniffed signature matches the target, the extension matches, and the MIME type is canonical. Otherwise it fails rather than offering a mislabelled file.
6. **Cleanup** runs in a `finally` on success, failure and cancellation: `ImageBitmap.close()`, revoking `<img>` decode URLs, and shrinking canvases to 0×0.

## Resource lifecycle

| Resource | Created | Released |
|---|---|---|
| Preview object URL | after inspection | `remove`, `clear` |
| Result object URL | after conversion | re-conversion (old URL revoked), `remove`, `clear` |
| Download URL | per download | 30 s later |
| `ImageBitmap`, decode `<img>` URL | per conversion | `finally` in the converter |
| Canvases | per conversion | `finally` (0×0) |
| WASM encoder | first WebP-via-WASM conversion | lives for the page (retried if loading failed) |

- Object URLs are **not** revoked on `pagehide`. The page may be restored from the back/forward cache, and revoked URLs would leave broken previews. The browser frees them when the document is discarded.
- **Concurrency:** files convert one at a time to bound peak memory. Each file has its own `AbortController`. `remove` aborts only that file, and `cancel` stops the batch.
- **Stale results:** a result that arrives for a removed file, or after `clear`, is dropped and no URL is created.
- **Abort points:** cancellation is checked between stages (decode → draw → encode → verify). A single native encode can't be interrupted midway; its result is discarded.

## Pixel limits (`src/core/limits.ts`)

`detectDeviceProfile` combines independent signals; any one of them marks the device as constrained:
- the user agent;
- `navigator.userAgentData.mobile`;
- a coarse pointer combined with a short screen side under 820 px;
- `navigator.deviceMemory`;
- iOS detection, including iPadOS in desktop mode.

`selectPixelPolicy` is a pure function, so it's unit-tested. The most conservative matching rule wins: iOS 16.7 MP, then ≤ 2 GB 12 MP, then ≤ 4 GB 24 MP, then mobile 24 MP, otherwise desktop 50 MP. The limits reduce the risk of the tab running out of memory but can't eliminate it.

## Security and privacy

- The production CSP is injected as a `<meta>` tag (`vite.config.ts`): `connect-src 'self'`, `worker-src 'none'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`, and `script-src 'self' 'wasm-unsafe-eval'` for the WebP encoder.
- There are no inline scripts or styles, no third-party origins and no analytics.
- Third-party licence texts are emitted into `THIRD_PARTY_NOTICES.txt` at build time from the installed packages.

## Phase 2 boundaries

Document conversion isn't implemented. When it is:

1. Add formats to `src/core/formats.ts` with `category: 'document'`. Extend `sniff` (PDF is already recognised and currently rejected) and `inspectFile`.
2. Create `src/modules/document/`, exporting `createDocumentConverter(caps)` and registering it in `src/main.ts`. The controller, queue, ZIP and download code need no changes.
3. **Lazy-load** heavy libraries inside `convert()` with `await import(...)`, as `loadWebpEncoder` does, so the image converter stays small to load.
4. Run CPU-heavy work in a Web Worker. This needs `worker-src 'self'` in the CSP, which is currently `'none'`. Pass `ArrayBuffer`s as transferables.
5. Route every output through a verifier like `verifyOutput`. A document converter must never offer a file under a misleading extension either.
6. Every new dependency needs owner approval, a licence check, and an entry in the third-party-notices plugin. Anything that needs a server or a third-party network request is out of scope by design and blocked by the CSP.
7. The UI will need per-category output choices; the current settings panel assumes images.

Candidate libraries, none installed yet:
- `pdf-lib` (MIT) to create and edit PDFs;
- `pdfjs-dist` (Apache-2.0) to render PDF pages to images;
- `mammoth` (BSD-2) for DOCX to HTML.

## Testing

| Suite | Config | Runs against |
|---|---|---|
| Unit | `vite.config.ts` (`test`) | Node, no browser |
| Browser, root | `playwright.config.ts` | `dist/` via `vite preview` at `/` |
| Browser, GitHub Pages | `playwright.pages.config.ts` | `dist-pages/` via `scripts/serve-pages.mjs` at `BASE_PATH` |
| Fixture generator | `tests/fixtures/playwright.fixtures.config.ts` | Chromium (WebKit can't encode WebP) |

Browser projects (`tests/playwright-projects.ts`): `chromium`, `mobile-chromium` (Pixel 7), `firefox`, `webkit`, and `mobile-webkit` (iPhone 13). Keyboard tests skip the mobile projects.

Several tests were checked by temporarily reintroducing the bug they guard against and confirming they fail:
- the thin-transparency defects;
- a late result after removal;
- revoking URLs on `pagehide`;
- canvases not released;
- the focus order;
- deploying a root build at the subpath;
- low-contrast text colours;
- cropped preview images.
