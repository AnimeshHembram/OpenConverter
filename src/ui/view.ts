/**
 * Plain-DOM view. Deliberately unstyled beyond a neutral token-based theme
 * (see styles.css) so the visual design can be reworked without touching the
 * controller or conversion modules. Every interactive element has a stable
 * `data-testid` used by the end-to-end tests.
 */
import { isStale, settingsKey, type AppState, type Controller, type FileItem } from '../app/controller';
import { acceptAttribute, findFormatById, getFormat } from '../core/formats';
import { MAX_FILE_BYTES, formatBytes } from '../core/limits';
import type { ImageCapabilities } from '../modules/image/capabilities';

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

const STATUS_LABEL: Record<FileItem['status'], string> = {
  inspecting: 'Checking file…',
  ready: 'Ready',
  queued: 'Waiting…',
  converting: 'Converting…',
  done: 'Converted',
  error: 'Error',
};

export function mountApp(root: HTMLElement, c: Controller, caps: ImageCapabilities): void {
  root.replaceChildren();

  // ---- Drop zone -------------------------------------------------------
  const input = h('input', {
    type: 'file',
    multiple: true,
    accept: acceptAttribute('image'),
    class: 'visually-hidden',
    id: 'file-input',
    'aria-labelledby': 'dropzone-title',
    'aria-describedby': 'dropzone-hint',
    'data-testid': 'file-input',
  });
  // The real <input> is visually hidden and placed *before* its label so the
  // label can show the input's keyboard focus (`#file-input:focus-visible +
  // .dropzone` in styles.css). Clicking the label opens the file picker.
  const dropzone = h(
    'label',
    { class: 'dropzone', for: 'file-input', 'data-testid': 'dropzone' },
    h('span', { class: 'dropzone-title', id: 'dropzone-title', text: 'Choose images or drop them here' }),
    h('span', {
      class: 'dropzone-hint',
      id: 'dropzone-hint',
      text: `PNG, JPEG, WebP or BMP · up to ${formatBytes(MAX_FILE_BYTES)} each · you can also paste`,
    }),
  );
  input.addEventListener('change', () => {
    if (input.files?.length) void c.addFiles(input.files);
    input.value = ''; // allow re-selecting the same file
  });
  let dragDepth = 0;
  dropzone.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    dropzone.classList.add('is-dragover');
  });
  dropzone.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      dropzone.classList.remove('is-dragover');
    }
  });
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropzone.classList.remove('is-dragover');
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) void c.addFiles(files);
  });
  // A file dropped beside the drop zone would otherwise navigate away.
  for (const t of ['dragover', 'drop'] as const) window.addEventListener(t, (e) => e.preventDefault());
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

  // ---- Settings --------------------------------------------------------
  const targets = c.availableTargets();
  const targetSelect = h('select', { id: 'target', 'data-testid': 'target' });
  for (const id of ['webp', 'jpeg', 'png', 'bmp']) {
    if (!targets.includes(id)) continue;
    const f = getFormat(id);
    const via = caps.encoders.get(id) === 'wasm' ? ' (built-in encoder)' : '';
    targetSelect.append(h('option', { value: id, text: `${f.label}${via}` }));
  }
  targetSelect.addEventListener('change', () => c.setSettings({ target: targetSelect.value }));

  const quality = h('input', { type: 'range', id: 'quality', min: 1, max: 100, step: 1, 'data-testid': 'quality' });
  // A plain span, not <output>: <output> is an implicit live region and would
  // compete with the notice. The slider already announces its own value.
  const qualityOut = h('span', { class: 'quality-value' });
  quality.addEventListener('input', () => c.setSettings({ quality: Number(quality.value) / 100 }));
  const qualityField = h('div', { class: 'field' }, h('label', { for: 'quality', text: 'Quality ' }, qualityOut), quality);

  const bg = h('input', { type: 'color', id: 'background', 'data-testid': 'background' });
  bg.addEventListener('input', () => c.setSettings({ background: bg.value }));
  const bgField = h(
    'div',
    { class: 'field' },
    h('label', { for: 'background', text: 'Fill for transparent areas' }),
    bg,
  );

  const formatNote = h('p', { class: 'field-note' });
  const settings = h(
    'section',
    { class: 'panel settings', 'aria-labelledby': 'settings-title' },
    h('h2', { id: 'settings-title', class: 'panel-title', text: 'Output' }),
    h('div', { class: 'settings-grid' }, h('div', { class: 'field' }, h('label', { for: 'target', text: 'Convert to' }), targetSelect), qualityField, bgField),
    formatNote,
  );

  // ---- Toolbar ---------------------------------------------------------
  const convertBtn = h('button', { type: 'button', class: 'btn btn-primary', 'data-testid': 'convert' });
  const cancelBtn = h('button', { type: 'button', class: 'btn', text: 'Cancel', 'data-testid': 'cancel' });
  const downloadAllBtn = h('button', { type: 'button', class: 'btn', 'data-testid': 'download-all' });
  const clearBtn = h('button', { type: 'button', class: 'btn btn-quiet', text: 'Clear all', 'data-testid': 'clear' });
  convertBtn.addEventListener('click', () => void c.convertAll());
  cancelBtn.addEventListener('click', () => c.cancel());
  downloadAllBtn.addEventListener('click', () => void c.downloadAll());
  clearBtn.addEventListener('click', () => {
    c.clear();
    input.focus(); // the list is gone; return focus to where files are added
  });
  const overall = h('progress', { class: 'overall', max: 1, value: 0, 'aria-label': 'Overall progress', 'data-testid': 'overall-progress' });
  const toolbar = h('div', { class: 'toolbar' }, convertBtn, cancelBtn, downloadAllBtn, clearBtn);

  const notice = h('div', { class: 'notice', role: 'status', 'aria-live': 'polite', 'data-testid': 'notice' });
  const list = h('ul', { class: 'file-list', 'aria-label': 'Files', 'data-testid': 'file-list' });
  const workspace = h('section', { class: 'workspace' }, toolbar, overall, notice, list);

  root.append(input, dropzone, settings, workspace);

  // ---- Rendering -------------------------------------------------------
  const cards = new Map<string, { el: HTMLLIElement; item?: FileItem; key?: string; refs: CardRefs }>();

  function render(s: AppState): void {
    const target = getFormat(s.settings.target);
    targetSelect.value = s.settings.target;
    quality.value = String(Math.round(s.settings.quality * 100));
    qualityOut.textContent = `${Math.round(s.settings.quality * 100)}%`;
    qualityField.hidden = !target.lossy;
    bg.value = s.settings.background;
    bgField.hidden = target.supportsAlpha;
    formatNote.textContent = target.id === 'bmp'
      ? 'BMP files are uncompressed and can be very large.'
      : target.id === 'png'
        ? 'PNG is lossless: no quality is lost, but files may be larger.'
        : caps.encoders.get(target.id) === 'wasm'
          ? 'Your browser has no built-in WebP encoder, so OpenConvert uses its own. It runs on your device too.'
          : '';
    formatNote.hidden = !formatNote.textContent;

    const key = settingsKey(s.settings);
    const pending = s.items.filter((i) => i.format && (i.status === 'ready' || i.status === 'error' || (i.status === 'done' && isStale(i, s.settings))));
    convertBtn.textContent = pending.length > 1 ? `Convert ${pending.length} files` : 'Convert';
    convertBtn.disabled = s.running || pending.length === 0;
    cancelBtn.hidden = !s.running;
    const downloadable = c.downloadableItems();
    downloadAllBtn.textContent = downloadable.length > 1 ? `Download all (${downloadable.length}) as ZIP` : 'Download';
    downloadAllBtn.disabled = s.running || downloadable.length === 0;
    clearBtn.disabled = s.items.length === 0;
    workspace.hidden = s.items.length === 0;

    const active = s.items.filter((i) => i.status === 'queued' || i.status === 'converting' || (s.running && i.status === 'done'));
    overall.hidden = !s.running;
    if (s.running && active.length) {
      overall.value = active.reduce((sum, i) => sum + (i.status === 'done' ? 1 : i.status === 'converting' ? i.progress : 0), 0) / active.length;
    }

    notice.textContent = s.notice?.text ?? '';
    notice.className = `notice${s.notice ? ` notice-${s.notice.kind}` : ''}`;
    notice.hidden = !s.notice;

    // Keyed list reconciliation: only changed cards are touched.
    const seen = new Set<string>();
    let prev: Element | null = null;
    for (const item of s.items) {
      seen.add(item.id);
      let card = cards.get(item.id);
      if (!card) {
        const refs = createCard(item.id, c, () => input);
        card = { el: refs.root, refs };
        cards.set(item.id, card);
      }
      if (card.item !== item || card.key !== key) {
        updateCard(card.refs, item, s);
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
  }

  c.subscribe(render);
}

interface CardRefs {
  root: HTMLLIElement;
  previews: HTMLElement;
  beforeImg: HTMLImageElement;
  afterImg: HTMLImageElement;
  afterFig: HTMLElement;
  name: HTMLElement;
  meta: HTMLElement;
  status: HTMLElement;
  progress: HTMLProgressElement;
  messages: HTMLUListElement;
  download: HTMLButtonElement;
  remove: HTMLButtonElement;
}

function createCard(id: string, c: Controller, fallbackFocus: () => HTMLElement): CardRefs {
  const beforeImg = h('img', { alt: '', class: 'thumb', decoding: 'async', loading: 'lazy' });
  const afterImg = h('img', { alt: '', class: 'thumb', decoding: 'async' });
  const afterFig = h('figure', { class: 'preview' }, afterImg, h('figcaption', { text: 'After' }));
  const name = h('p', { class: 'file-name' });
  const meta = h('p', { class: 'file-meta' });
  const status = h('p', { class: 'file-status', 'data-testid': 'status' });
  const progress = h('progress', { max: 1, value: 0, class: 'file-progress', 'data-testid': 'file-progress' });
  const messages = h('ul', { class: 'file-messages' });
  const download = h('button', { type: 'button', class: 'btn btn-primary btn-small', 'data-testid': 'download' });
  const remove = h('button', { type: 'button', class: 'btn btn-quiet btn-small', text: 'Remove', 'data-testid': 'remove' });
  download.addEventListener('click', () => c.download(id));
  remove.addEventListener('click', () => {
    // Keep keyboard focus in a sensible place when this card disappears:
    // the next card's Remove button, else the previous one, else the input.
    const card = remove.closest('li');
    const neighbour = (card?.nextElementSibling ?? card?.previousElementSibling)?.querySelector<HTMLElement>('[data-testid=remove]');
    c.remove(id);
    (neighbour ?? fallbackFocus()).focus();
  });
  const previews = h('div', { class: 'previews' }, h('figure', { class: 'preview' }, beforeImg, h('figcaption', { text: 'Before' })), afterFig);
  const root = h(
    'li',
    { class: 'file-card', 'data-testid': 'file-card', 'data-id': id },
    previews,
    h('div', { class: 'file-body' }, name, meta, status, progress, messages, h('div', { class: 'file-actions' }, download, remove)),
  );
  return { root, previews, beforeImg, afterImg, afterFig, name, meta, status, progress, messages, download, remove };
}

function updateCard(r: CardRefs, item: FileItem, s: AppState): void {
  r.root.dataset.status = item.status;
  r.name.textContent = item.name;
  r.name.title = item.name;
  const parts = [item.format?.label, item.width && item.height ? `${item.width} × ${item.height}` : undefined, formatBytes(item.size)];
  r.meta.textContent = parts.filter(Boolean).join(' · ');

  if (item.previewUrl && r.beforeImg.getAttribute('src') !== item.previewUrl) {
    r.beforeImg.src = item.previewUrl;
    r.beforeImg.alt = `Original: ${item.name}`;
  }
  r.beforeImg.hidden = !item.previewUrl;
  r.previews.hidden = !item.previewUrl;
  r.root.classList.toggle('no-preview', !item.previewUrl);

  const res = item.result;
  r.afterFig.hidden = !res;
  if (res && r.afterImg.getAttribute('src') !== res.url) {
    r.afterImg.src = res.url;
    r.afterImg.alt = `Converted: ${res.fileName}`;
  }

  const stale = isStale(item, s.settings);
  let statusText = STATUS_LABEL[item.status];
  if (item.status === 'converting' && item.stage) statusText = `${item.stage}…`;
  if (item.status === 'done' && res) {
    const delta = res.blob.size - item.size;
    const pct = Math.round((Math.abs(delta) / item.size) * 100);
    statusText = `Converted to ${res.format.label} · ${formatBytes(res.blob.size)} (${delta <= 0 ? `${pct}% smaller` : `${pct}% larger`})`;
    if (stale) statusText += ' · settings changed, convert again to update';
  }
  r.status.textContent = statusText;
  r.progress.hidden = item.status !== 'converting';
  r.progress.value = item.progress;
  r.progress.setAttribute('aria-label', `Converting ${item.name}`);

  const msgs: [string, string][] = [];
  if (item.error) msgs.push(['error', item.error]);
  for (const w of item.inputWarnings) msgs.push(['warning', w]);
  for (const w of res?.warnings ?? []) msgs.push(['warning', w]);
  // A text prefix, so the meaning doesn't depend on colour alone.
  r.messages.replaceChildren(
    ...msgs.map(([kind, text]) =>
      h('li', { class: `msg msg-${kind}` }, h('strong', { text: kind === 'error' ? 'Error: ' : 'Note: ' }), text),
    ),
  );
  r.messages.hidden = msgs.length === 0;

  r.download.hidden = !res;
  if (res) {
    r.download.textContent = `Download ${findFormatById(res.format.id)?.label ?? ''}`.trim();
    r.download.setAttribute('aria-label', `Download ${res.fileName}`);
    r.download.title = res.fileName;
  }
  r.remove.setAttribute('aria-label', `Remove ${item.name}`);
}
