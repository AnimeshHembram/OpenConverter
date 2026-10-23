/**
 * Tracks object URLs by owner so each one is revoked exactly once when the
 * file it belongs to is removed, replaced, or the page is closed.
 */
export class ObjectUrlPool {
  private readonly byOwner = new Map<string, Set<string>>();

  create(owner: string, blob: Blob): string {
    const url = URL.createObjectURL(blob);
    let set = this.byOwner.get(owner);
    if (!set) this.byOwner.set(owner, (set = new Set()));
    set.add(url);
    return url;
  }

  revoke(owner: string, url: string): void {
    const set = this.byOwner.get(owner);
    if (set?.delete(url)) URL.revokeObjectURL(url);
  }

  revokeOwner(owner: string): void {
    const set = this.byOwner.get(owner);
    if (!set) return;
    for (const url of set) URL.revokeObjectURL(url);
    this.byOwner.delete(owner);
  }

  revokeAll(): void {
    for (const owner of [...this.byOwner.keys()]) this.revokeOwner(owner);
  }

  get size(): number {
    let n = 0;
    for (const s of this.byOwner.values()) n += s.size;
    return n;
  }
}

/** Save a blob with the given name. The temporary URL is revoked shortly after. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Some browsers start the download asynchronously; give them time.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
