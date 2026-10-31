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
4. **Edits** (`edits.ts`, pure functions on RGBA bytes, unit-tested in Node), only when requested, on the full-resolution canvas pixels:
   - background removal (`removeImageBackground` in `converter.ts`) chooses between two methods:
     - **Colour key** (`edits.ts`): `analyseBackground` finds the dominant edge colour (4-bit-per-channel bins) and flood-fills the connected region within the tolerance, then grows it into soft shadows (darker, same hue, gradual) on light backgrounds. It changes no pixels; it reports `plain` only when the edges match (≥ 85%), the region is neither nothing nor everything, and ≥ 60% of the kept region's outline differs clearly from the background colour. `applyBackgroundKey` then clears the region, keeps shadows as see-through black, and gives outline pixels their coverage by projecting each onto the line from the background colour to the nearby subject colour, unmixing the background out of them (no halo).
     - **Person segmentation** (`segment.ts`, `tflite.ts`, `matte.ts`): the MediaPipe selfie segmentation model (256 × 256 input, sigmoid output) runs on a dependency-free TFLite interpreter that implements exactly the model's ten float32 operators and refuses anything else; a unit test checks it against Google's LiteRT output. The model file is served from `assets/models/`, fetched on first use and verified against a pinned SHA-256. `cleanProbabilities` drops detached blobs under 3% of the main subject; `refineMatte` keeps the model's answer where it's certain (p ≥ 0.9 or ≤ 0.1) and, in the band between, estimates each full-resolution pixel's coverage from its colour between the local subject and background colours (sampling-based matting), falling back to the model where those colours are too alike. `applyMatte` only changes alpha.
     - Order: the colour key is used when the background is plain and it wouldn't cut more than 2% into a person the model found; otherwise the model, when it finds a person (coverage ≥ 1%, mean confidence ≥ 0.55, with a "check the edges" note below 0.75); otherwise `BACKGROUND_NOT_FOUND`, leaving the image unchanged. The standalone file has no model, so only plain backgrounds work there.
     - An earlier version applied the colour key to every image. On low-light photos the dark key colour matched dark clothing and hair, so it deleted the subject and kept the lights; that is the regression the `rainyStreet` scene (`tests/fixtures/scenes.ts`) guards against;
   - colour: grayscale (Rec. 709 luma) or black and white (Otsu threshold). Alpha is kept.
   After edits, outputs without alpha are flattened onto the chosen colour as in step 3.
5. **Encode** with one of four encoders:
   - native `canvas.toBlob` for PNG and JPEG, and WebP where supported;
   - the lazy-loaded WASM WebP encoder;
   - the JS BMP encoder;
   - the PDF writer (`pdf.ts`): the canvas is encoded as JPEG and embedded unchanged in a one-page PDF (DCTDecode). Offered only where the browser encodes JPEG natively.

   With a size limit (`compress.ts`), lossy encoders are called repeatedly: first at the chosen quality, then a binary search (at most 8 more encodes) for the highest quality that fits, keeping the smallest result if nothing fits.

   WASM *load* failures and *encode* failures give different, actionable messages, and a failed load can be retried.
6. **`verifyOutput`** checks every encoder path: the output is non-empty, the sniffed signature matches the target, the extension matches, and the MIME type is canonical. Otherwise it fails rather than offering a mislabelled file.
7. **Cleanup** runs in a `finally` on success, failure and cancellation: `ImageBitmap.close()`, revoking `<img>` decode URLs, and shrinking canvases to 0×0.

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

- The production CSP is injected as a `<meta>` tag (`vite.config.ts`): `connect-src 'self'`, `worker-src 'self'` (pdf.js), `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`, and `script-src 'self' 'wasm-unsafe-eval'` for the WebP encoder.
- There are no inline scripts or styles, no third-party origins and no analytics.
- Third-party licence texts are emitted into `THIRD_PARTY_NOTICES.txt` at build time from the installed packages.

## Documents (Level 2)

**Stage 1 (done): text and data.**
- `src/core/text.ts` decodes text (BOM, strict UTF-8, then Windows-1252) and classifies it: JSON by parsing, CSV by a delimiter that splits the first lines consistently, Markdown by counting syntax features. `.csv`/`.md` extensions are trusted; a `.txt` only becomes CSV or Markdown when the content is unambiguous.
- `src/core/zipdir.ts` reads only a ZIP's central directory to tell `.docx`, `.xlsx`, `.pptx` and OpenDocument apart. `sniff` also recognises the Office 97–2003 container; those files are rejected with advice to re-save.
- `src/modules/document/` registers the `document-text` converter: `table.ts` (JSON ↔ rows, typing, Markdown/HTML tables), `markdown.ts` (`marked`), `xlsx.ts` (`exceljs`, loaded with `import()` on first use). `DOCUMENT_OUTPUTS` lists each input's outputs, default first. Every output passes `verifyDocument` (extension, UTF-8 text, JSON parses, workbook structure).
- Documents choose their output per file (`FileItem.target`, `Controller.setTarget`); images keep the shared settings. `itemKey` decides when a result is out of date.
- The standalone build can't load lazy chunks from `file://`, so it registers the converter with `spreadsheets: false` and Excel files are explained rather than offered.

**Stage 2 (done): PDF.**
- `src/modules/pdf/pdfjs.ts` lazily loads pdf.js's *legacy* build (the standard build needs `Map.prototype.getOrInsertComputed`, which current browsers lack) with its worker. Even the legacy build reads page text with `for await (… of readableStream)`, which Safari only supports from version 27, so `stream-iterator.ts` adds a spec-following `ReadableStream` async iterator where it's missing, on the page (before pdf.js loads) and in the worker: `pdf.worker.ts` is our worker entry, which installs it and then imports pdf.js's worker (built as an ES module, `worker.format: 'es'`). Without it, every PDF text extraction failed in Safari 26 and earlier while page rendering still worked. `vite.config.ts` emits worker files as `.js` (some static hosts serve `.mjs` as binary, which stops module workers) and copies pdf.js's data files to `assets/pdfjs/` (character maps, standard fonts, ICC profile, WebAssembly decoders; not the scripting sandbox). The CSP allows `worker-src 'self'`.
- `src/modules/pdf/text.ts` rebuilds lines and paragraphs from positioned text: fragments on one baseline form a line, a gap well above the most common line spacing or a font-size change starts a paragraph, and headings are lines ≥1.25× (h2) or ≥1.6× (h1) the body size.
- `src/modules/pdf/converter.ts`: pages → PNG/JPEG via canvas at 150 dpi (scaled down to the device pixel policy), ZIP when there are several pages; text, Markdown and Word via `text.ts` and blocks; compression via pdf-lib (see README). pdf-lib saves every object it holds, so only kept pages are copied into a rebuilt PDF.
- `src/modules/document/blocks.ts` is the shared document model (headings, styled runs, list items, code, quotes, tables, rules, page breaks). `pdfwriter.ts` (pdf-lib, standard fonts, WinAnsi coverage check) and `docxwriter.ts` (docx) render it, so Markdown, text, tables and PDF text share one PDF and one Word writer.

**Next stages:** Word input (`mammoth` to read `.docx`), PowerPoint (`jszip` to read slides). Each loads lazily.

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
