/**
 * Application state and actions, independent of how the page looks. The UI
 * layer subscribes to state changes and calls these actions; it can be
 * redesigned freely without touching conversion logic.
 */
import { ConversionError, isAbort, userMessage } from '../core/errors';
import { dedupeNames } from '../core/filename';
import { findFormatById } from '../core/formats';
import { inspectFile } from '../core/inspect';
import { MAX_BATCH_FILES } from '../core/limits';
import { ObjectUrlPool, downloadBlob } from '../core/objectUrls';
import { findConverter, outputsFor } from '../core/registry';
import type { ConversionResult, ConvertOptions, FormatInfo } from '../core/types';
import { createZip } from '../core/zip';

export type ItemStatus = 'inspecting' | 'ready' | 'queued' | 'converting' | 'done' | 'error';

export interface FileItem {
  id: string;
  file: File;
  name: string;
  size: number;
  status: ItemStatus;
  format?: FormatInfo;
  width?: number;
  height?: number;
  /** Warnings about the input file itself. */
  inputWarnings: string[];
  error?: string;
  progress: number;
  stage?: string;
  previewUrl?: string;
  result?: ConversionResult & { url: string; settingsKey: string };
}

export interface Settings extends ConvertOptions {
  target: string;
}

export interface AppState {
  items: FileItem[];
  settings: Settings;
  running: boolean;
  notice?: { kind: 'info' | 'error'; text: string };
}

type Listener = (s: AppState) => void;

let idCounter = 0;
const nextId = () => `f${++idCounter}`;

export const settingsKey = (s: Settings) => `${s.target}|${s.target === 'jpeg' || s.target === 'webp' ? s.quality : ''}|${s.background}`;

export function isStale(item: FileItem, settings: Settings): boolean {
  return !!item.result && item.result.settingsKey !== settingsKey(settings);
}

export class Controller {
  private state: AppState;
  private readonly listeners = new Set<Listener>();
  private readonly urls = new ObjectUrlPool();
  private batchAbort: AbortController | null = null;
  private current: { id: string; ctrl: AbortController } | null = null;

  constructor(initial: Settings) {
    this.state = { items: [], settings: initial, running: false };
    addEventListener('pagehide', () => this.urls.revokeAll());
  }

  get snapshot(): AppState {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  private updateItem(id: string, patch: Partial<FileItem>): void {
    this.set({ items: this.state.items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });
  }

  private item(id: string): FileItem | undefined {
    return this.state.items.find((i) => i.id === id);
  }

  /** Output formats available for at least one loaded file (or all image outputs). */
  availableTargets(): string[] {
    return outputsFor('png');
  }

  setSettings(patch: Partial<Settings>): void {
    this.set({ settings: { ...this.state.settings, ...patch } });
  }

  dismissNotice(): void {
    this.set({ notice: undefined });
  }

  async addFiles(files: Iterable<File>): Promise<void> {
    const list = [...files];
    const room = MAX_BATCH_FILES - this.state.items.length;
    if (list.length > room) {
      this.set({ notice: { kind: 'error', text: `You can add up to ${MAX_BATCH_FILES} files at a time. ${list.length - Math.max(0, room)} were skipped.` } });
      list.length = Math.max(0, room);
    }
    const added: FileItem[] = list.map((file) => ({
      id: nextId(),
      file,
      name: file.name || 'image',
      size: file.size,
      status: 'inspecting',
      inputWarnings: [],
      progress: 0,
    }));
    this.set({ items: [...this.state.items, ...added] });

    await Promise.all(
      added.map(async (it) => {
        try {
          const info = await inspectFile(it.file);
          if (!this.item(it.id)) return; // removed meanwhile
          this.updateItem(it.id, {
            status: 'ready',
            format: info.format,
            width: info.dimensions?.width,
            height: info.dimensions?.height,
            inputWarnings: info.warnings,
            // The original file is previewed directly: no decode or copy needed.
            previewUrl: this.urls.create(it.id, it.file),
          });
        } catch (e) {
          if (!this.item(it.id)) return;
          this.updateItem(it.id, { status: 'error', error: userMessage(e) });
        }
      }),
    );
  }

  remove(id: string): void {
    const it = this.item(id);
    if (!it) return;
    if (this.current?.id === id) this.current.ctrl.abort();
    this.urls.revokeOwner(id);
    this.set({ items: this.state.items.filter((i) => i.id !== id) });
  }

  clear(): void {
    this.cancel();
    this.urls.revokeAll();
    this.set({ items: [], notice: undefined });
  }

  cancel(): void {
    this.batchAbort?.abort();
    this.current?.ctrl.abort();
  }

  /** Convert every file that has no up-to-date result. One at a time, to bound memory. */
  async convertAll(): Promise<void> {
    if (this.state.running) return;
    const { settings } = this.state;
    const key = settingsKey(settings);
    const todo = this.state.items.filter(
      (i) => i.format && (i.status === 'ready' || (i.status === 'error' && i.format) || (i.status === 'done' && i.result?.settingsKey !== key)),
    );
    if (!todo.length) return;

    this.batchAbort = new AbortController();
    const batchSignal = this.batchAbort.signal;
    this.set({ running: true, notice: undefined });
    for (const it of todo) this.updateItem(it.id, { status: 'queued', progress: 0, error: undefined });

    let failed = 0;
    for (const it of todo) {
      if (batchSignal.aborted) break;
      if (!this.item(it.id)) continue;
      this.updateItem(it.id, { status: 'converting', progress: 0, stage: 'Starting' });
      // A per-file controller lets "remove" cancel just this file.
      const ctrl = new AbortController();
      this.current = { id: it.id, ctrl };
      const signal = ctrl.signal;
      try {
        const converter = findConverter(it.format!.id, settings.target);
        const result = await converter.convert(
          { file: it.file, name: it.name, format: it.format! },
          settings.target,
          settings,
          {
            signal,
            onProgress: (p) => this.updateItem(it.id, { progress: p.fraction, stage: p.stage }),
          },
        );
        if (!this.item(it.id)) continue;
        const old = this.item(it.id)?.result;
        if (old) this.urls.revoke(it.id, old.url);
        const url = this.urls.create(it.id, result.blob);
        this.updateItem(it.id, { status: 'done', progress: 1, stage: undefined, result: { ...result, url, settingsKey: key } });
      } catch (e) {
        if (!this.item(it.id)) continue;
        if (isAbort(e)) {
          this.updateItem(it.id, { status: it.result ? 'done' : 'ready', progress: 0, stage: undefined });
        } else {
          failed++;
          console.error(`[OpenConvert] ${it.name}:`, e);
          this.updateItem(it.id, { status: 'error', progress: 0, stage: undefined, error: userMessage(e) });
        }
      }
      this.current = null;
      // Yield so the browser can paint and collect garbage between files.
      await new Promise((r) => setTimeout(r, 0));
    }

    // Anything still queued after a cancel goes back to ready.
    for (const it of this.state.items) {
      if (it.status === 'queued') this.updateItem(it.id, { status: it.result ? 'done' : 'ready' });
    }
    const cancelled = batchSignal.aborted;
    this.batchAbort = null;
    this.set({
      running: false,
      notice: cancelled
        ? { kind: 'info', text: 'Conversion cancelled.' }
        : failed
          ? { kind: 'error', text: `${failed} file${failed > 1 ? 's' : ''} couldn't be converted. See the details below.` }
          : undefined,
    });
  }

  download(id: string): void {
    const r = this.item(id)?.result;
    if (r) downloadBlob(r.blob, r.fileName);
  }

  async downloadAll(): Promise<void> {
    const done = this.downloadableItems();
    if (done.length === 0) return;
    if (done.length === 1) return this.download(done[0]!.id);
    try {
      const names = dedupeNames(done.map((i) => i.result!.fileName));
      const zip = await createZip(done.map((i, n) => ({ name: names[n]!, data: i.result!.blob })));
      const fmt = findFormatById(this.state.settings.target);
      downloadBlob(zip, `openconvert-${done.length}-${fmt?.extensions[0] ?? 'files'}.zip`);
    } catch (e) {
      this.set({ notice: { kind: 'error', text: e instanceof ConversionError || e instanceof Error ? e.message : String(e) } });
    }
  }

  /** Converted files whose result matches the current settings. */
  downloadableItems(): FileItem[] {
    return this.state.items.filter((i) => i.result && !isStale(i, this.state.settings));
  }

  /** For tests/diagnostics: number of live object URLs. */
  get liveObjectUrls(): number {
    return this.urls.size;
  }
}
