// Characters Windows, macOS and Android reject in file names.
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

export function stripExtension(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

export function sanitizeBaseName(name: string): string {
  let s = name.replace(ILLEGAL, '_').replace(/[. ]+$/, '').trim();
  if (!s || RESERVED.test(s)) s = s ? `${s}_` : 'image';
  return s.slice(0, 200);
}

/** "holiday photo.PNG" + "jpg" -> "holiday photo.jpg" */
export function outputFileName(inputName: string, extension: string): string {
  return `${sanitizeBaseName(stripExtension(inputName))}.${extension}`;
}

/** Make names unique within one batch download: a.jpg, a (2).jpg, a (3).jpg */
export function dedupeNames(names: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const key = n.toLowerCase();
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    if (count === 0) return n;
    const dot = n.lastIndexOf('.');
    const base = dot > 0 ? n.slice(0, dot) : n;
    const ext = dot > 0 ? n.slice(dot) : '';
    let i = count + 1;
    let candidate = `${base} (${i})${ext}`;
    while (seen.has(candidate.toLowerCase())) candidate = `${base} (${++i})${ext}`;
    seen.set(candidate.toLowerCase(), 1);
    return candidate;
  });
}
