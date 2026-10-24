/**
 * Plain-DOM view: presentation only. It reads state from the Controller and
 * calls its actions; it never touches conversion modules. Colours, spacing
 * and type all come from tokens in styles.css. Every interactive element has
 * a stable `data-testid` used by the end-to-end tests.
 */
import { isImage, isStale, itemKey, type AppState, type Controller, type FileItem } from '../app/controller';
import { acceptAttribute, getFormat } from '../core/formats';
import type { FormatInfo } from '../core/types';
import { MAX_BATCH_FILES, MAX_FILE_BYTES, formatBytes } from '../core/limits';
import type { ColourMode } from '../core/types';
import type { ImageCapabilities } from '../modules/image/capabilities';
import { parseSize } from '../modules/image/compress';

type Attrs = Record<string, string | boolean | number | undefined>;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Node | string | null)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'text') el.textContent = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null) el.append(c);
  return el;
}

/** Small monochrome line icons (decorative: always aria-hidden). */
const ICONS = {
  upload: 'M12 15V4m0 0 4 4m-4-4-4 4M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3',
  download: 'M12 4v11m0 0 4-4m-4 4-4-4M5 19h14',
  close: 'M6 6l12 12M18 6 6 18',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z',
  expand: 'M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7',
  open: 'M14 4h6v6m0-6-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
} as const;

function icon(name: keyof typeof ICONS, size = 16): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('icon');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

const STATUS_LABEL: Record<FileItem['status'], string> = {
  inspecting: 'Checking file…',
  ready: 'Ready',
  queued: 'Waiting…',
  converting: 'Converting…',
  done: 'Converted',
  error: 'Not converted',
};

export function mountApp(root: HTMLElement, c: Controller, caps: ImageCapabilities): void {
  root.replaceChildren();

  // ---- Upload zone -----------------------------------------------------
  // The real <input> is visually hidden and placed *before* its label, so
  // the label can show the input's keyboard focus (styles.css). Clicking
  // anywhere on the label opens the native file picker.
  const input = h('input', {
    type: 'file',
    multiple: true,
    accept: acceptAttribute(),
    class: 'visually-hidden',
    id: 'file-input',
    'aria-labelledby': 'dropzone-title',
    'aria-describedby': 'dropzone-hint',
    'data-testid': 'file-input',
  });
  const zoneStatus = h('span', { class: 'dz-status', 'aria-live': 'polite' });
  const dropzone = h(
    'label',
    { class: 'dropzone', for: 'file-input', 'data-testid': 'dropzone' },
    h('span', { class: 'dz-icon' }, icon('upload', 22)),
    h(
      'span',
      { class: 'dz-text' },
      h('span', { class: 'dz-title', id: 'dropzone-title', text: 'Drop your files here' }),
      h('span', { class: 'dz-browse', text: 'or browse files' }),
    ),
    h('span', {
      class: 'dz-meta',
      id: 'dropzone-hint',
      text: `Images (PNG, JPEG, WebP, BMP), text, Markdown, JSON, CSV or Excel · up to ${formatBytes(MAX_FILE_BYTES)} per file · up to ${MAX_BATCH_FILES} files · you can also paste`,
    }),
    zoneStatus,
  );
  const privacy = h(
    'p',
    { class: 'privacy' },
    icon('lock', 14),
    h('span', { text: 'Your files are converted on this device and never uploaded.' }),
  );

  input.addEventListener('change', () => {
    if (input.files?.length) void c.addFiles(input.files);
    input.value = ''; // allow re-selecting the same file
  });

  let zoneMessageTimer: number | undefined;
  const showZoneError = (text: string) => {
    window.clearTimeout(zoneMessageTimer);
    dropzone.classList.add('is-error');
    zoneStatus.textContent = text;
    zoneMessageTimer = window.setTimeout(() => {
      dropzone.classList.remove('is-error');
      zoneStatus.textContent = '';
    }, 4000);
  };

  // Drag state: count enter/leave pairs so child elements don't flicker it.
  let dragDepth = 0;
  const carriesFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  const endDrag = () => {
    dragDepth = 0;
    dropzone.classList.remove('is-dragover');
  };
  window.addEventListener('dragenter', (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    dropzone.classList.add('is-dragover');
  });
  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) endDrag();
  });
  window.addEventListener('dragover', (e) => {
    e.preventDefault(); // otherwise the browser would navigate to the file
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  // Files can be dropped anywhere on the page, not only on the zone.
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    endDrag();
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) void c.addFiles(files);
    else showZoneError('Nothing to add. Drop image files, not text or links.');
  });
  window.addEventListener('paste', (e) => {
    // Some browsers expose pasted images only through `items` (e.g. a
    // screenshot copied to the clipboard), others through `files`.
    const data = e.clipboardData;
    let files = [...(data?.files ?? [])];
    if (!files.length && data?.items) {
      files = [...data.items].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter((f): f is File => !!f);
    }
    if (files.length) void c.addFiles(files);
  });

  // ---- Output settings -------------------------------------------------
  const targets = c.availableTargets();
  const targetSelect = h('select', { id: 'target', class: 'select', 'data-testid': 'target' });
  for (const id of ['webp', 'jpeg', 'png', 'bmp', 'pdf']) {
    if (!targets.includes(id)) continue;
    const f = getFormat(id);
    const via = caps.encoders.get(id) === 'wasm' ? ' (built-in encoder)' : '';
    targetSelect.append(h('option', { value: id, text: `${f.label}${via}` }));
  }
  targetSelect.addEventListener('change', () => c.setSettings({ target: targetSelect.value }));
  const targetLabel = h('label', { for: 'target', class: 'field-label', text: 'Convert all to' });

  const quality = h('input', { type: 'range', id: 'quality', class: 'range', min: 1, max: 100, step: 1, 'data-testid': 'quality' });
  // A plain span, not <output>: <output> is an implicit live region and would
  // compete with the notice. The slider already announces its own value.
  const qualityOut = h('span', { class: 'field-value' });
  quality.addEventListener('input', () => c.setSettings({ quality: Number(quality.value) / 100 }));
  const qualityField = h(
    'div',
    { class: 'field field-quality' },
    h('label', { for: 'quality', class: 'field-label' }, 'Quality ', qualityOut),
    quality,
  );

  const bg = h('input', { type: 'color', id: 'background', class: 'color', 'data-testid': 'background' });
  const bgLabel = h('label', { for: 'background', class: 'field-label', text: 'Fill for transparent areas' });
  bg.addEventListener('input', () => c.setSettings({ background: bg.value }));
  const bgField = h(
    'div',
    { class: 'field field-color' },
    bgLabel,
    bg,
  );

  // Compress: an optional size limit for lossy outputs. Quality is lowered
  // per file until it fits. The text is kept as typed (render never rewrites
  // it) so partial input like "1." isn't clobbered.
  const maxSize = h('input', {
    type: 'text',
    inputmode: 'decimal',
    id: 'max-size',
    class: 'text-input',
    placeholder: 'No limit',
    autocomplete: 'off',
    'aria-describedby': 'max-size-hint',
    'data-testid': 'max-size',
  });
  const maxUnit = h('select', { class: 'select select-unit', 'aria-label': 'Size unit', 'data-testid': 'max-size-unit' },
    h('option', { value: 'KB', text: 'KB' }),
    h('option', { value: 'MB', text: 'MB' }),
  );
  const maxHint = h('span', { class: 'field-hint', id: 'max-size-hint' });
  const applyMaxSize = () => {
    const bytes = parseSize(maxSize.value, maxUnit.value as 'KB' | 'MB');
    const invalid = maxSize.value.trim() !== '' && bytes === null;
    maxSize.setAttribute('aria-invalid', String(invalid));
    maxHint.textContent = invalid ? 'Enter a number, e.g. 200' : '';
    c.setSettings({ maxBytes: bytes });
  };
  maxSize.addEventListener('input', applyMaxSize);
  maxUnit.addEventListener('change', applyMaxSize);
  const maxField = h(
    'div',
    { class: 'field field-max' },
    h('label', { for: 'max-size', class: 'field-label', text: 'Compress to under' }),
    h('div', { class: 'input-group' }, maxSize, maxUnit),
    maxHint,
  );

  // ---- Edits -------------------------------------------------------------
  const colourSelect = h(
    'select',
    { id: 'colour', class: 'select', 'data-testid': 'colour' },
    h('option', { value: 'original', text: 'Original colours' }),
    h('option', { value: 'grayscale', text: 'Grayscale' }),
    h('option', { value: 'bw', text: 'Black and white' }),
  );
  colourSelect.addEventListener('change', () => c.setSettings({ colour: colourSelect.value as ColourMode }));
  const colourField = h(
    'div',
    { class: 'field field-colour' },
    h('label', { for: 'colour', class: 'field-label', text: 'Colour' }),
    colourSelect,
  );

  const removeBg = h('input', { type: 'checkbox', id: 'remove-bg', class: 'checkbox', 'aria-describedby': 'remove-bg-hint', 'data-testid': 'remove-bg' });
  removeBg.addEventListener('change', () => c.setSettings({ removeBackground: removeBg.checked }));
  const removeBgField = h(
    'div',
    { class: 'field field-removebg' },
    h('span', { class: 'field-label', 'aria-hidden': 'true', text: 'Background' }),
    h('label', { for: 'remove-bg', class: 'check' }, removeBg, h('span', { text: 'Remove background' })),
    h('span', { class: 'field-hint', id: 'remove-bg-hint', text: 'Works on plain, solid-colour backgrounds' }),
  );
  const tolerance = h('input', { type: 'range', id: 'bg-tolerance', class: 'range', min: 0, max: 100, step: 1, 'data-testid': 'bg-tolerance' });
  const toleranceOut = h('span', { class: 'field-value' });
  tolerance.addEventListener('input', () => c.setSettings({ bgTolerance: Number(tolerance.value) }));
  const toleranceField = h(
    'div',
    { class: 'field field-tolerance' },
    h('label', { for: 'bg-tolerance', class: 'field-label' }, 'Tolerance ', toleranceOut),
    tolerance,
  );

  const formatNote = h('p', { class: 'format-note' });
  const settings = h(
    'div',
    { class: 'settings-panel' },
    h(
      'div',
      { class: 'settings', role: 'group', 'aria-label': 'Output settings' },
      h('div', { class: 'field field-target' }, targetLabel, targetSelect),
      qualityField,
      maxField,
    ),
    h(
      'div',
      { class: 'settings settings-edits', role: 'group', 'aria-label': 'Edits' },
      colourField,
      removeBgField,
      toleranceField,
      bgField,
    ),
  );

  // ---- File list and actions --------------------------------------------
  const listTitle = h('h2', { class: 'list-title', id: 'files-title' });
  const listSummary = h('span', { class: 'list-summary', 'data-testid': 'list-summary' });
  const list = h('ul', { class: 'file-list', 'aria-labelledby': 'files-title', 'data-testid': 'file-list' });

  const convertBtn = h('button', { type: 'button', class: 'btn btn-primary', 'data-testid': 'convert' });
  const cancelBtn = h('button', { type: 'button', class: 'btn', text: 'Cancel', 'data-testid': 'cancel' });
  const downloadAllBtn = h('button', { type: 'button', class: 'btn', 'data-testid': 'download-all' });
  const clearBtn = h('button', { type: 'button', class: 'btn btn-ghost', text: 'Clear all', 'data-testid': 'clear' });
  convertBtn.addEventListener('click', () => void c.convertAll());
  cancelBtn.addEventListener('click', () => c.cancel());
  downloadAllBtn.addEventListener('click', () => void c.downloadAll());
  clearBtn.addEventListener('click', () => {
    c.clear();
    input.focus(); // the list is gone; return focus to where files are added
  });

  const overall = h('progress', { class: 'overall', max: 1, value: 0, 'aria-label': 'Overall progress', 'data-testid': 'overall-progress' });
  const notice = h('div', { class: 'notice', role: 'status', 'aria-live': 'polite', 'data-testid': 'notice' });
  const actionbar = h(
    'div',
    { class: 'actionbar' },
    overall,
    notice,
    h('div', { class: 'actions' }, clearBtn, cancelBtn, downloadAllBtn, convertBtn),
  );

  const workspace = h(
    'section',
    { class: 'workspace', 'aria-labelledby': 'files-title' },
    h('div', { class: 'list-header' }, h('div', { class: 'list-heading' }, listTitle, listSummary), formatNote),
    settings,
    list,
    actionbar,
  );

  const preview = createPreviewDialog(c);
  root.append(input, dropzone, privacy, workspace, preview.dialog);

  // ---- Rendering -------------------------------------------------------
  const cards = new Map<string, { el: HTMLLIElement; item?: FileItem; key?: string; refs: CardRefs }>();

  function render(s: AppState): void {
    const target = getFormat(s.settings.target);
    targetSelect.value = s.settings.target;
    quality.value = String(Math.round(s.settings.quality * 100));
    qualityOut.textContent = `${Math.round(s.settings.quality * 100)}%`;
    qualityField.hidden = !target.lossy;
    maxField.hidden = !target.lossy;
    bg.value = s.settings.background;
    bgField.hidden = target.supportsAlpha;
    bgLabel.textContent = s.settings.removeBackground ? 'Background colour' : 'Fill for transparent areas';
    colourSelect.value = s.settings.colour ?? 'original';
    removeBg.checked = !!s.settings.removeBackground;
    toleranceField.hidden = !s.settings.removeBackground;
    tolerance.value = String(s.settings.bgTolerance ?? 25);
    toleranceOut.textContent = String(s.settings.bgTolerance ?? 25);
    // Controls are locked while a batch runs, so results match what's shown.
    for (const el of [targetSelect, quality, maxSize, maxUnit, bg, colourSelect, removeBg, tolerance]) el.disabled = s.running;
    formatNote.textContent = target.id === 'bmp'
      ? 'BMP files are uncompressed and can be very large.'
      : target.id === 'png'
        ? 'PNG is lossless: no quality is lost, but files may be larger.'
        : target.id === 'pdf'
          ? 'Each image becomes a one-page PDF. The page is stored as a JPEG at the quality you choose.'
          : caps.encoders.get(target.id) === 'wasm'
            ? 'Your browser has no built-in WebP encoder, so OpenConverter uses its own. It runs on this device too.'
            : '';
    formatNote.hidden = !formatNote.textContent;

    const has = s.items.length > 0;
    document.body.classList.toggle('has-files', has);
    workspace.hidden = !has;
    // Image settings only matter when there are images; documents choose per row.
    const images = s.items.some((i) => isImage(i));
    const documents = s.items.some((i) => i.format && !isImage(i));
    settings.hidden = !images;
    formatNote.hidden ||= !images;
    targetLabel.textContent = documents ? 'Convert images to' : 'Convert all to';
    listTitle.textContent = `${s.items.length} ${s.items.length === 1 ? 'file' : 'files'}`;
    const converted = s.items.filter((i) => i.status === 'done' && !isStale(i, s.settings)).length;
    const failed = s.items.filter((i) => i.status === 'error').length;
    listSummary.textContent = [converted ? `${converted} converted` : '', failed ? `${failed} not converted` : ''].filter(Boolean).join(' · ');
    listSummary.hidden = !listSummary.textContent;

    const inspecting = s.items.some((i) => i.status === 'inspecting');
    dropzone.classList.toggle('is-busy', inspecting);
    if (inspecting) zoneStatus.textContent = 'Checking files…';
    else if (!dropzone.classList.contains('is-error')) zoneStatus.textContent = '';

    const pending = s.items.filter((i) => i.format && (i.status === 'ready' || i.status === 'error' || (i.status === 'done' && isStale(i, s.settings))));
    convertBtn.textContent = pending.length > 1 ? `Convert ${pending.length} files` : 'Convert';
    // While converting, Cancel takes Convert's place and downloads wait.
    convertBtn.disabled = s.running || pending.length === 0;
    convertBtn.hidden = s.running;
    cancelBtn.hidden = !s.running;
    const downloadable = c.downloadableItems();
    downloadAllBtn.textContent = downloadable.length > 1 ? `Download all (${downloadable.length}) as ZIP` : 'Download';
    downloadAllBtn.hidden = s.running || downloadable.length === 0;
    clearBtn.disabled = !has;

    const active = s.items.filter((i) => i.status === 'queued' || i.status === 'converting' || (s.running && i.status === 'done'));
    overall.hidden = !s.running;
    if (s.running && active.length) {
      overall.value = active.reduce((sum, i) => sum + (i.status === 'done' ? 1 : i.status === 'converting' ? i.progress : 0), 0) / active.length;
    }

    notice.textContent = s.notice?.text ?? '';
    notice.dataset.kind = s.notice?.kind ?? '';
    notice.hidden = !s.notice;

    // Keyed list reconciliation: only changed rows are touched.
    const seen = new Set<string>();
    let prev: Element | null = null;
    for (const item of s.items) {
      seen.add(item.id);
      let card = cards.get(item.id);
      if (!card) {
        const refs = createCard(item.id, c, () => input, (id, opener) => preview.open(id, opener));
        card = { el: refs.root, refs };
        cards.set(item.id, card);
      }
      const key = `${itemKey(item, s.settings)}|${s.running}`;
      if (card.item !== item || card.key !== key) {
        updateCard(card.refs, item, s, c);
        card.item = item;
        card.key = key;
      }
      const expectedPos: Element | null = prev ? prev.nextElementSibling : list.firstElementChild;
      if (expectedPos !== card.el) list.insertBefore(card.el, expectedPos);
      prev = card.el;
    }
    for (const [id, card] of cards) {
      if (!seen.has(id)) {
        card.el.remove();
        cards.delete(id);
      }
    }
    preview.update(s);
  }

  c.subscribe(render);
}

interface CardRefs {
  root: HTMLLIElement;
  previews: HTMLElement;
  beforeImg: HTMLImageElement;
  beforeDoc: HTMLElement;
  afterImg: HTMLImageElement;
  afterDoc: HTMLElement;
  afterFig: HTMLElement;
  name: HTMLElement;
  meta: HTMLElement;
  targetField: HTMLElement;
  targetSelect: HTMLSelectElement;
  status: HTMLElement;
  progress: HTMLProgressElement;
  messages: HTMLUListElement;
  previewBtn: HTMLButtonElement;
  download: HTMLButtonElement;
  remove: HTMLButtonElement;
}

function createCard(
  id: string,
  c: Controller,
  fallbackFocus: () => HTMLElement,
  openPreview: (id: string, opener: HTMLElement) => void,
): CardRefs {
  const beforeImg = h('img', { alt: '', class: 'thumb', decoding: 'async', loading: 'lazy' });
  // Documents get a tile showing their type instead of a picture.
  const beforeDoc = h('span', { class: 'thumb thumb-doc', 'aria-hidden': 'true' });
  const afterImg = h('img', { alt: '', class: 'thumb', decoding: 'async' });
  // Results that aren't images (PDF, CSV, Excel…) get a tile too.
  const afterDoc = h('span', { class: 'thumb thumb-doc', 'aria-hidden': 'true' });
  const afterFig = h(
    'figure',
    { class: 'preview preview-after' },
    afterImg,
    afterDoc,
    h('figcaption', { class: 'visually-hidden', text: 'After' }),
  );
  const previews = h(
    'div',
    { class: 'previews' },
    h('figure', { class: 'preview' }, beforeImg, beforeDoc, h('figcaption', { class: 'visually-hidden', text: 'Before' })),
    afterFig,
  );
  const name = h('p', { class: 'file-name' });
  const meta = h('p', { class: 'file-meta' });
  // Each document chooses its own output; images follow the shared settings.
  const targetSelect = h('select', { class: 'select select-small', id: `target-${id}`, 'data-testid': 'row-target' });
  targetSelect.addEventListener('change', () => c.setTarget(id, targetSelect.value));
  const targetField = h('div', { class: 'row-target' }, h('label', { for: `target-${id}`, class: 'row-target-label', text: 'Convert to' }), targetSelect);
  const status = h('p', { class: 'file-status', 'data-testid': 'status' });
  const progress = h('progress', { max: 1, value: 0, class: 'file-progress', 'data-testid': 'file-progress' });
  const messages = h('ul', { class: 'file-messages' });
  const download = h(
    'button',
    { type: 'button', class: 'btn btn-small', 'data-testid': 'download' },
    icon('download', 15),
    h('span', { text: 'Download' }),
  );
  const remove = h('button', { type: 'button', class: 'icon-btn', 'data-testid': 'remove', title: 'Remove' }, icon('close', 16));
  const previewBtn = h('button', { type: 'button', class: 'icon-btn', 'data-testid': 'preview', title: 'Preview' }, icon('expand', 16));
  previewBtn.addEventListener('click', () => openPreview(id, previewBtn));
  // Clicking a thumbnail is a mouse shortcut; keyboard users use the button.
  previews.addEventListener('click', () => openPreview(id, previewBtn));
  download.addEventListener('click', () => c.download(id));
  remove.addEventListener('click', () => {
    // Keep keyboard focus in a sensible place when this row disappears:
    // the next row's Remove button, else the previous one, else the input.
    const card = remove.closest('li');
    const neighbour = (card?.nextElementSibling ?? card?.previousElementSibling)?.querySelector<HTMLElement>('[data-testid=remove]');
    c.remove(id);
    (neighbour ?? fallbackFocus()).focus();
  });
  const root = h(
    'li',
    { class: 'file-row', 'data-testid': 'file-card', 'data-id': id },
    previews,
    h('div', { class: 'file-body' }, name, meta, targetField, status, progress, messages),
    h('div', { class: 'file-actions' }, download, previewBtn, remove),
  );
  return { root, previews, beforeImg, beforeDoc, afterImg, afterDoc, afterFig, name, meta, targetField, targetSelect, status, progress, messages, previewBtn, download, remove };
}

/** Short type label for document tiles: "CSV", "XLSX", "MD"… */
const tileLabel = (f: FormatInfo) => f.extensions[0]!.toUpperCase();

/** Text formats that can be previewed as text. */
const TEXT_FORMATS = new Set(['txt', 'md', 'json', 'csv', 'html']);

function updateCard(r: CardRefs, item: FileItem, s: AppState, c: Controller): void {
  r.root.dataset.status = item.status;
  r.name.textContent = item.name;
  r.name.title = item.name;
  const parts = [item.format?.label, item.details ?? (item.width && item.height ? `${item.width} × ${item.height}` : undefined), formatBytes(item.size)];
  r.meta.textContent = parts.filter(Boolean).join(' · ');

  const docIn = !!item.format && !isImage(item);
  r.beforeImg.hidden = docIn;
  r.beforeDoc.hidden = !docIn;
  if (docIn) r.beforeDoc.textContent = tileLabel(item.format!);
  else if (item.previewUrl && r.beforeImg.getAttribute('src') !== item.previewUrl) {
    r.beforeImg.src = item.previewUrl;
    r.beforeImg.alt = `Original: ${item.name}`;
  }

  // Per-file output choice, for documents only.
  r.targetField.hidden = !docIn;
  if (docIn) {
    const targets = c.targetsFor(item.id);
    if (r.targetSelect.dataset.options !== targets.join(',')) {
      r.targetSelect.replaceChildren(...targets.map((t) => h('option', { value: t, text: getFormat(t).label })));
      r.targetSelect.dataset.options = targets.join(',');
    }
    r.targetSelect.value = item.target ?? '';
    r.targetSelect.disabled = s.running;
    r.targetSelect.setAttribute('aria-label', `Convert ${item.name} to`);
  }
  r.previews.hidden = !item.previewUrl;
  r.root.classList.toggle('no-preview', !item.previewUrl);

  const res = item.result;
  r.afterFig.hidden = !res;
  r.root.classList.toggle('has-result', !!res);
  const isDoc = !!res && res.format.category !== 'image';
  r.afterImg.hidden = isDoc;
  r.afterDoc.hidden = !isDoc;
  if (res && isDoc) {
    r.afterDoc.textContent = tileLabel(res.format);
    r.afterImg.removeAttribute('src');
  } else if (res && r.afterImg.getAttribute('src') !== res.url) {
    r.afterImg.src = res.url;
    r.afterImg.alt = `Converted: ${res.fileName}`;
  }

  const stale = isStale(item, s.settings);
  let statusText = STATUS_LABEL[item.status];
  if (item.status === 'converting' && item.stage) statusText = `${item.stage}…`;
  if (item.status === 'done' && res) {
    const delta = res.blob.size - item.size;
    const pct = Math.round((Math.abs(delta) / item.size) * 100);
    // Size change only means something between image formats; a CSV and a workbook aren't comparable.
    const change = docIn ? '' : ` (${delta <= 0 ? `${pct}% smaller` : `${pct}% larger`})`;
    statusText = `Converted to ${res.format.label} · ${formatBytes(res.blob.size)}${change}`;
    if (stale) statusText += docIn ? ' · output changed, convert again to update' : ' · settings changed, convert again to update';
  }
  r.status.textContent = statusText;
  r.status.dataset.stale = String(stale);
  r.progress.hidden = item.status !== 'converting';
  r.progress.value = item.progress;
  r.progress.setAttribute('aria-label', `Converting ${item.name}`);

  const msgs: [string, string][] = [];
  if (item.error) msgs.push(['error', item.error]);
  for (const w of item.inputWarnings) msgs.push(['warning', w]);
  for (const w of res?.warnings ?? []) msgs.push(['warning', w]);
  // A text prefix, so the meaning never depends on styling alone.
  r.messages.replaceChildren(
    ...msgs.map(([kind, text]) =>
      h('li', { class: `msg msg-${kind}` }, h('strong', { text: kind === 'error' ? 'Error: ' : 'Note: ' }), text),
    ),
  );
  r.messages.hidden = msgs.length === 0;

  r.download.hidden = !res;
  if (res) {
    r.download.setAttribute('aria-label', `Download ${res.fileName}`);
    r.download.title = res.fileName;
  }
  r.remove.setAttribute('aria-label', `Remove ${item.name}`);
  r.previewBtn.hidden = !item.previewUrl;
  r.previewBtn.setAttribute('aria-label', `Preview ${item.name}`);
}

/**
 * Large before/after preview in a native modal <dialog>: focus is trapped
 * inside, Escape closes it, and focus returns to the button that opened it.
 */
function createPreviewDialog(c: Controller) {
  const title = h('h2', { class: 'pd-title', id: 'preview-title' });
  const closeBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close preview', 'data-testid': 'preview-close' }, icon('close', 18));
  const panes = h('div', { class: 'pd-panes' });
  const footer = h('div', { class: 'pd-footer' });
  const dialog = h(
    'dialog',
    { class: 'preview-dialog', 'aria-labelledby': 'preview-title', 'data-testid': 'preview-dialog' },
    h('div', { class: 'pd-header' }, title, closeBtn),
    panes,
    footer,
  );
  let openId: string | null = null;
  let opener: HTMLElement | null = null;
  let rendered: FileItem | undefined;

  const close = () => {
    if (dialog.open) dialog.close();
  };
  closeBtn.addEventListener('click', close);
  // A click on the backdrop lands on the <dialog> element itself.
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) close();
  });
  dialog.addEventListener('close', () => {
    openId = null;
    rendered = undefined;
    // Return focus to the opener if it still exists, as native dialogs do.
    if (opener?.isConnected) opener.focus();
    opener = null;
  });

  /** Text files are previewed as text: the first 20 KB, set with textContent (never parsed as HTML). */
  const textPreview = (blob: Blob, label: string) => {
    const pre = h('pre', { class: 'pd-text', tabindex: 0, 'aria-label': label, 'data-testid': 'text-preview' });
    pre.textContent = 'Loading…';
    const LIMIT = 20_000;
    blob
      .slice(0, LIMIT)
      .arrayBuffer()
      .then((buf) => {
        const text = new TextDecoder().decode(buf);
        pre.textContent = blob.size > LIMIT ? `${text}\n…` : text;
      })
      .catch(() => {
        pre.textContent = "This file couldn't be previewed.";
      });
    return h('div', { class: 'pd-image pd-textwrap' }, pre);
  };

  const docTile = (format: FormatInfo, description: string, src?: string) =>
    h(
      'div',
      { class: 'pd-image pd-empty pd-doc' },
      h('span', { class: 'pd-doc-badge', 'aria-hidden': 'true', text: tileLabel(format) }),
      h('span', { text: description }),
      // The browser's own PDF viewer shows it; nothing leaves the device.
      src ? h('a', { href: src, target: '_blank', rel: 'noopener', class: 'btn btn-small', 'data-testid': 'open-pdf' }, icon('open', 15), h('span', { text: 'Open PDF' })) : null,
    );

  /** Picture, text or a tile, depending on the format. */
  const content = (blob: Blob, format: FormatInfo, src: string, alt: string) => {
    if (format.category === 'image') return h('div', { class: 'pd-image' }, h('img', { src, alt, decoding: 'async' }));
    if (TEXT_FORMATS.has(format.id)) return textPreview(blob, alt);
    if (format.id === 'pdf') return docTile(format, 'One-page PDF document', src);
    if (format.id === 'xlsx') return docTile(format, 'Excel workbook: open it in Excel, Google Sheets or Numbers');
    return docTile(format, `${format.label} file`);
  };

  const pane = (label: string, caption: string, body: HTMLElement) =>
    h(
      'figure',
      { class: 'pd-pane' },
      h('figcaption', { class: 'pd-label' }, h('span', { text: label }), h('span', { class: 'pd-meta', text: caption })),
      body,
    );

  function render(item: FileItem) {
    rendered = item;
    title.textContent = item.name;
    const dims = item.width && item.height ? `${item.width} × ${item.height}` : '';
    const res = item.result;
    panes.replaceChildren(
      pane(
        'Original',
        [item.format?.label, item.details ?? dims, formatBytes(item.size)].filter(Boolean).join(' · '),
        content(item.file, item.format!, item.previewUrl!, `Original: ${item.name}`),
      ),
      pane(
        'Converted',
        res ? [res.format.label, res.width && res.height ? `${res.width} × ${res.height}` : '', formatBytes(res.blob.size)].filter(Boolean).join(' · ') : '',
        res ? content(res.blob, res.format, res.url, `Converted: ${res.fileName}`) : h('div', { class: 'pd-image pd-empty', text: 'Not converted yet' }),
      ),
    );
    footer.replaceChildren();
    if (res) {
      const dl = h('button', { type: 'button', class: 'btn btn-primary', 'aria-label': `Download ${res.fileName}` }, icon('download', 15), h('span', { text: `Download ${res.format.label}` }));
      dl.addEventListener('click', () => c.download(item.id));
      footer.append(dl);
    }
    footer.hidden = !res;
  }

  return {
    dialog,
    open(id: string, from: HTMLElement) {
      const item = c.snapshot.items.find((i) => i.id === id);
      if (!item?.previewUrl) return;
      openId = id;
      opener = from;
      render(item);
      if (!dialog.open) dialog.showModal();
      closeBtn.focus();
    },
    /** Keep an open preview in sync: new result, or close if the file is gone. */
    update(s: AppState) {
      if (!openId) return;
      const item = s.items.find((i) => i.id === openId);
      if (!item) close();
      else if (item !== rendered && (item.result !== rendered?.result || item.previewUrl !== rendered?.previewUrl)) render(item);
    },
  };
}
