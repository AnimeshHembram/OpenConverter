# Architecture

## Layers

```
 UI (src/ui)            renders state, forwards user actions
        │ subscribe / call
 Controller (src/app)   state, queue, cancellation, downloads, object-URL lifetime
        │ registry lookups
 Core (src/core)        formats, detection, validation, limits, registry, zip
        │ Converter interface
 Modules (src/modules)  image/ (Phase 1) · document/ (Phase 2) · …
```

- The **UI** never imports a module. The visual design can be replaced completely while keeping `Controller`'s public methods and `AppState`.
- The **controller** knows nothing about pixels or pages. It asks the registry for a `Converter` that can turn format A into format B.
- **Modules** register `Converter`s (`src/core/types.ts`). A converter declares which outputs it can produce for an input *in this browser* (`outputsFor`) and performs one conversion with progress and an `AbortSignal`.

## Conversion pipeline (images)

1. `inspectFile`: size limits, magic-byte sniffing, a dimension check read from the header (rejects decompression bombs before decoding), and a warning when the extension doesn't match the content.
2. `decodeImage`: our BMP decoder, or `createImageBitmap` (EXIF orientation applied), falling back to `<img>.decode()`.
3. Transparency check. For JPEG output, transparent areas are filled with the chosen colour.
4. Encode: native `canvas.toBlob`, the lazy-loaded WASM WebP encoder, or the JS BMP encoder.
5. `verifyOutput`: sniff the output's bytes. If they aren't the requested format, fail instead of mislabelling.
6. Release the bitmap and shrink the canvas to 0×0 so memory is freed promptly.

Files are processed one at a time to bound peak memory. Each file has its own `AbortController`, so removing a file cancels only that file and **Cancel** stops the batch.

## Adding document conversion (Phase 2)

1. Add formats to `src/core/formats.ts` with `category: 'document'`, and extend `sniff` (PDF is already recognised).
2. Create `src/modules/document/` exporting `createDocumentConverter(caps)`.
3. **Lazy-load heavy libraries** inside `convert()` with `await import(...)`, as `encodeWebpWasm` does. The image converter's first load stays at about 12 KB gzipped.
4. Run long or CPU-heavy work in a Web Worker (CSP already allows `worker-src 'self' blob:`). Pass `ArrayBuffer`s as transferables.
5. Register it in `src/main.ts`. The controller and the queue need no changes. The UI will need a category or target picker per file type.

Candidate open-source libraries, to be approved before adding: `pdf-lib` (MIT) to create and edit PDFs, `pdfjs-dist` (Apache-2.0) to render PDF pages to images, and `mammoth` (BSD-2) for DOCX → HTML. Any library that needs a server or network access is ruled out by design and by the CSP.

## Testing strategy

- **Unit (Vitest, Node):** pure logic, including format sniffing, header dimension parsing, BMP encode/decode round trips (24/32-bit, padding, top-down, palettes), file names, ZIP structure and CRC, and validation messages.
- **End-to-end (Playwright, Chromium desktop and mobile emulation):** real conversions through the UI. The tests check downloaded bytes, file names, dimensions, pixel values (alpha kept or filled), the WASM fallback, ZIP contents, errors for bad files, object-URL cleanup, and that no request goes to another origin.
- **Not yet automated:** Firefox and WebKit. Add them to `playwright.config.ts` projects once their browsers are installed in CI (`npx playwright install --with-deps firefox webkit`). WebKit is the important one, because it exercises the native-WebP-missing path for real.
