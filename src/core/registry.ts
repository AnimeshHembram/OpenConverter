import { ConversionError } from './errors';
import type { Converter } from './types';

const converters: Converter[] = [];

export function registerConverter(c: Converter): void {
  if (converters.some((x) => x.id === c.id)) throw new Error(`Converter already registered: ${c.id}`);
  converters.push(c);
}

/** All output format ids reachable from `fromId`, across every module. */
export function outputsFor(fromId: string): string[] {
  const out = new Set<string>();
  for (const c of converters) for (const id of c.outputsFor(fromId)) out.add(id);
  return [...out];
}

/** The name to show for converting `fromId` to `toId`. */
export function outputLabel(fromId: string, toId: string, fallback: string): string {
  for (const c of converters) {
    const l = c.outputLabel?.(fromId, toId);
    if (l) return l;
  }
  return fallback;
}

/** A user-facing reason why nothing can convert `fromId` here, if a converter knows one. */
export function unavailableReason(fromId: string): string | undefined {
  for (const c of converters) {
    const r = c.unavailableReason?.(fromId);
    if (r) return r;
  }
  return undefined;
}

export function findConverter(fromId: string, toId: string): Converter {
  const c = converters.find((x) => x.outputsFor(fromId).includes(toId));
  if (!c) throw new ConversionError('NO_CONVERTER', `Converting ${fromId} to ${toId} isn't available in this browser.`);
  return c;
}

/** Test hook. */
export function _resetRegistry(): void {
  converters.length = 0;
}
