# OpenConverter

Free, open-source file conversion that runs **entirely in your browser**. No account, no uploads, no server, no tracking.

**Level 1, images:** convert between PNG, JPEG, WebP and BMP, save images as PDF, make them grayscale or black and white, remove plain backgrounds and compress to a size limit, one file or a batch.

**Level 2, documents (stages 1–2 of 4 done):** text, Markdown, JSON, CSV, Excel and PDF, with Word output. Reading Word and PowerPoint files is next (see [Documents](#documents)).

Live site (once GitHub Pages is enabled): `https://animeshhembram.github.io/OpenConverter/`

## Features

- Add files by clicking the upload area, dragging and dropping them anywhere on the page, or pasting.
- Light and dark themes: follows your system until you choose, then remembers your choice.
- A large before/after preview for each file, with format, dimensions and size, and a download button.
- The real format is detected from the file's bytes, not its name. A wrong extension gets a warning.
- Each file shows its name, format, dimensions (as displayed, after photo rotation) and size, with before and after previews.
- Quality setting for JPEG, WebP and PDF. A background colour fills transparent areas when converting to JPEG or PDF.
- **PDF output:** each image becomes a one-page PDF, sized to the image at 96 px per inch. The page image is a JPEG embedded unchanged (no PDF library is used). PDF input is covered under [Documents](#documents).
- **Colour:** original, grayscale (Rec. 709 luma) or two-tone black and white (the threshold is chosen per image with Otsu's method).
- **Remove background:** two methods, and the app picks the one that can be trusted for each image:
  - **People in photos:** an on-device AI model (Google's MediaPipe selfie segmentation, Apache-2.0) finds the person, and the outline is refined at full resolution from the photo's own colours, so it follows real edges and keeps strands of hair. Works in low light and on dark backgrounds where colour rules fail (a dark coat on a dark street). The ~250 KB model is downloaded once from this site, checked against a fixed SHA-256, and run by OpenConverter's own small interpreter. Your photo never leaves the device.
  - **Anything on a plain background** (product shots, logos, scans): a colour key that removes the solid-colour region connected to the image's edges, with a tolerance slider. Edge pixels get their true partial transparency with the old background colour taken out, so there's no halo, and soft shadows on light backgrounds are kept as see-through shadows.
  - If neither fits (a busy scene with no person, or a dark object on a dark backdrop), the file fails with an explanation and nothing is changed, instead of producing a damaged image.
  - PNG and WebP keep real transparency. JPEG and PDF can't, so the removed background is filled with the chosen colour. Colours of the subject are never altered where it's opaque, and the output has the same size as the input.
- **Compress to under N KB/MB** (JPEG, WebP, PDF): the quality is lowered, per file, to the highest setting that fits. If even the lowest quality is too big, the smallest version is kept and the app explains why.
- Settings are locked while a batch converts, so every result matches what's on screen.
- Batch conversion with progress, cancel and per-file remove. "Download all" gives a ZIP with unique file names.
- Every output is checked before it's offered: it must be non-empty, have the right file signature, the right MIME type and a matching extension. A browser that silently produces the wrong format gets an error instead of a mislabelled file.

## Documents

Every file is identified from its content, not just its name: JSON by parsing it, CSV by a consistent delimiter (comma, semicolon, tab or pipe), Markdown by its syntax, and Office files by the parts inside them. A `.txt` file holding JSON is treated as JSON, and the app says so. Each document row has its own **Convert to** choice; images keep the shared settings.

| From | To |
|---|---|
| Text (.txt) | PDF, Word, Markdown (escaped so it reads the same), HTML |
| Markdown | PDF, Word, HTML (a complete page), plain text |
| JSON | CSV, Excel, Markdown table |
| CSV / TSV | Excel, JSON, PDF table, Markdown table, HTML table |
| Excel (.xlsx) | CSV, JSON, PDF table, Markdown, HTML |
| PDF | PNG or JPEG images (one per page, 150 dpi; a ZIP when there are several), Word (text), text, Markdown, a smaller PDF |

- **Excel:** `.xlsx` files open and edit in Microsoft Excel, Google Sheets, Numbers and LibreOffice. The header row is bold and frozen, and columns are sized to their content. Formulas are read as their last calculated values. A workbook with several sheets becomes one JSON object (one list per sheet), or Markdown/HTML with a section per sheet; CSV holds one table, so only the first sheet is used and the app says so.
- **Types:** CSV values that are plain numbers become numbers, and true/false become booleans. Numbers with leading zeros (phone numbers, PIN codes, IDs) and very long digit strings stay text, so nothing is mangled. Text starting with `=` is stored as text in Excel, never as a formula.
- **CSV output** has a UTF-8 byte-order mark so Excel shows accents and non-Latin scripts correctly.
- **Previews:** text outputs are shown as source text in the preview, never rendered as HTML.
- **PDF reading** uses Mozilla's pdf.js in a background worker. PDF JavaScript is never run, and forms aren't rendered.
  - *Text, Markdown and Word* keep text, paragraphs and headings (spotted by font size). Layout, fonts, images and tables aren't kept. Pages with no selectable text (scans) are left out with a note; a PDF that is all scans gets an explanation, because reading text from images (OCR) isn't available yet.
  - *Images* are rendered at 150 dpi (less for very large pages, to respect the device's pixel limit), up to 300 pages at a time.
  - *Smaller PDF* rebuilds the file with compressed object streams and drops unused data. Pages that are scans (images with no text) are also tried as JPEG at 150 dpi; pages with text are never turned into pictures. The smallest result wins, and if nothing is noticeably smaller the original is kept and the app says so. When scans are re-compressed, bookmarks and form fields aren't kept.
  - Password-protected PDFs get a clear message.
- **Writing PDF and Word:** PDFs have real, selectable text, wrapped and paginated, with headings, lists, code blocks, quotes and tables (header rows repeat on each page; wide tables use landscape). The built-in PDF fonts cover Western European text: other scripts (Hindi, Chinese, emoji…) appear as "?" and the app says so and suggests Word or HTML, which keep every character. Word files have real headings, bulleted and numbered lists, tables and links.
- **Not supported yet:** Word (.docx) and PowerPoint (.pptx) input (coming in the next stages); old Office 97–2003 files (.doc, .xls, .ppt) and OpenDocument (.ods, .odt, .odp), which get advice to re-save in the current format; HTML input. Limits: 50 MB for text and data files, 25 MB for workbooks.
- **Standalone file:** opened from disk, it converts images, text, Markdown, JSON and CSV. Excel, PDF input and PDF/Word output need the website or `npm start`, because those libraries are separate files that browsers won't load from disk.

## Format behaviour and known limitations

| Topic | Behaviour |
|---|---|
| **Transparency** | Kept in PNG and WebP. Kept in BMP by writing a 32-bit BMP (some older apps show transparent areas as black, and the app says so). JPEG can't store transparency, so transparent areas are filled with the chosen colour and the app says so. Transparency is detected at full resolution, so thin features aren't missed. |
| **Animation** | Animated PNG (APNG) and animated WebP are detected from their headers and **only the first frame is converted**. A note says this before conversion. Animated output isn't supported. If a file's header can't be read far enough to tell, no claim is made either way. GIF isn't supported yet. |
| **Photo rotation (EXIF)** | Rotated JPEGs are shown and converted the right way up, and the displayed size accounts for rotation. If a browser ever ignores the rotation, the app warns that the result may be sideways. |
| **Metadata** | Conversion goes through a canvas, so EXIF (including GPS location), colour profiles and other metadata are **not** copied to the output. Images in wide-gamut colour spaces are converted to sRGB. |
| **Other inputs** | GIF, HEIC/HEIF, AVIF, TIFF, ICO and SVG are recognised and rejected with a clear message. |
| **Background removal** | The photo model recognises **people only**. A pet, car or product in a busy scene isn't found (the file fails with an explanation); products on a plain background use the colour key instead. It works on a 256 × 256 view of the photo, so on large images the outline can show slight 2–4 px steps where the photo has no clear edge, and very fine flyaway hair against a similar-coloured background may be lost. In very dark or cluttered photos the model can include nearby objects (a flag behind someone, something they hold); the app adds a "check the edges" note when it's unsure. Shadows on the ground under a person are removed; soft shadows under objects on a plain light background are kept. |
| **PDF output** | One image per PDF, stored as JPEG, so transparency is filled with the chosen colour. Combining several images into one PDF isn't supported yet. |

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
| PDF output | Built-in TypeScript writer around the browser's JPEG encoder. |
| BMP input | Built-in decoder for consistent transparency, with the browser as a fallback for rare variants (RLE). |

Encoders are detected at startup by checking what the browser actually produces, not by its name.

**Tested automatically:** Chromium (desktop, and Pixel 7 emulation). Firefox, WebKit and iPhone (WebKit) emulation are configured as CI test projects but haven't been run yet; the first CI run will be their first run. See [Testing](#testing) for what still needs a real device.

## Privacy and security

These claims apply to the production site:

- Images are processed in the browser and are never uploaded. There is no backend, analytics, tracking, cookies or account.
- The page carries a Content-Security-Policy with `connect-src 'self'` and `worker-src 'self'` (the PDF reader's worker). The browser blocks any request to another site, and a test checks this. GitHub Pages can't send custom headers, so the policy is a `<meta>` tag. That means `frame-ancestors` (clickjacking protection) can't be set.
- The only network requests are to this site itself: the page, its scripts and styles, and, when needed, the WebP encoder, the PDF reader's files and the background-removal model. The browser tests check that conversions make no request to any other origin.
- `Referrer-Policy: no-referrer` is set for links that leave the site.

## Development

Requires Node 20 or newer (CI uses Node 22).

```bash
npm ci                       # clean install from the lockfile
npm start                    # dev server, opens the app in your browser
npm run dev                  # dev server without opening a browser
npm run typecheck
npm test                     # unit tests (Vitest)
npm run build                # production build at "/" into dist/, plus dist-standalone/index.html
npm run build:pages          # production build at /OpenConverter/ into dist-pages/
npx playwright install       # once: browsers for the end-to-end tests
npm run test:e2e             # browser tests against dist/ (all projects)
npm run test:e2e:pages       # browser tests against dist-pages/ served at its subpath
npm run test:all             # everything above, in order
npm run test:all:chromium    # same, Chromium only (faster locally)
npm run fixtures             # regenerate binary test fixtures (APNG, animated WebP, rotated JPEG)
```

**Opening from disk:** the source `index.html` can't run on its own (it's TypeScript that Vite compiles). `npm run build` also creates `dist-standalone/index.html`, a single self-contained file you can double-click or copy anywhere: no server, no network. Its security policy allows exactly its inlined code by hash. From disk, browsers can't load the WebAssembly WebP encoder, so in that file WebP output appears only in browsers that encode WebP natively (Chrome, Edge, Firefox); Safari users get PNG, JPEG and BMP. For development use `npm start`; to preview the production build use `npm run preview` (http://localhost:4173).

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

The published site includes third-party code: `@jsquash/webp` (Apache-2.0), libwebp (BSD-3-Clause), `wasm-feature-detect` (Apache-2.0), `marked` (MIT), `exceljs` (MIT, which bundles JSZip, pako and other permissively licensed packages), `pdfjs-dist` (Apache-2.0, with its fonts, character maps and WebAssembly decoders), `pdf-lib` (MIT), `docx` (MIT) and the MediaPipe selfie segmentation model from `@mediapipe/selfie_segmentation` (Apache-2.0; only the model file is shipped). Their licence texts are generated into `THIRD_PARTY_NOTICES.txt` at build time and linked from the site footer.
