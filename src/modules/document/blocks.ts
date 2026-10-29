/**
 * A small document model shared by the PDF and Word writers: headings,
 * paragraphs with bold/italic/code runs, list items, code blocks, quotes,
 * tables, rules and page breaks. Markdown, plain text, tables and text
 * extracted from PDFs are all turned into blocks first, so every source gets
 * the same PDF and Word output.
 */
import { Marked, type Token, type Tokens } from 'marked';

export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  /** Link target, kept in Word output. */
  link?: string;
}

export type Block =
  | { kind: 'heading'; level: number; runs: Run[] }
  | { kind: 'para'; runs: Run[] }
  | { kind: 'item'; ordered: boolean; number: number; depth: number; runs: Run[] }
  | { kind: 'code'; text: string }
  | { kind: 'quote'; runs: Run[] }
  | { kind: 'table'; rows: string[][]; header: boolean }
  | { kind: 'rule' }
  | { kind: 'pagebreak' };

const marked = new Marked({ gfm: true });

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m]!);

/** Inline Markdown tokens to styled runs. */
function inline(tokens: Token[] | undefined, style: Omit<Run, 'text'> = {}): Run[] {
  const out: Run[] = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case 'strong':
        out.push(...inline((t as Tokens.Strong).tokens, { ...style, bold: true }));
        break;
      case 'em':
        out.push(...inline((t as Tokens.Em).tokens, { ...style, italic: true }));
        break;
      case 'del':
        out.push(...inline((t as Tokens.Del).tokens, style));
        break;
      case 'codespan':
        out.push({ ...style, code: true, text: decode((t as Tokens.Codespan).text) });
        break;
      case 'link':
        out.push(...inline((t as Tokens.Link).tokens, { ...style, link: (t as Tokens.Link).href }));
        break;
      case 'image':
        out.push({ ...style, text: (t as Tokens.Image).text });
        break;
      case 'br':
        out.push({ ...style, text: '\n' });
        break;
      case 'html':
        break;
      default:
        if ('tokens' in t && t.tokens?.length) out.push(...inline(t.tokens, style));
        else if ('text' in t) out.push({ ...style, text: decode(String(t.text)) });
    }
  }
  return out;
}

function fromTokens(tokens: Token[], out: Block[], depth = 0): void {
  for (const t of tokens) {
    switch (t.type) {
      case 'heading':
        out.push({ kind: 'heading', level: (t as Tokens.Heading).depth, runs: inline((t as Tokens.Heading).tokens) });
        break;
      case 'paragraph':
        out.push({ kind: 'para', runs: inline((t as Tokens.Paragraph).tokens) });
        break;
      case 'text':
        out.push({ kind: 'para', runs: (t as Tokens.Text).tokens ? inline((t as Tokens.Text).tokens) : [{ text: decode((t as Tokens.Text).text) }] });
        break;
      case 'code':
        out.push({ kind: 'code', text: (t as Tokens.Code).text });
        break;
      case 'blockquote': {
        const inner: Block[] = [];
        fromTokens((t as Tokens.Blockquote).tokens, inner, depth);
        for (const b of inner) out.push(b.kind === 'para' || b.kind === 'heading' ? { kind: 'quote', runs: b.runs } : b);
        break;
      }
      case 'list': {
        const list = t as Tokens.List;
        list.items.forEach((item, i) => {
          const inner: Block[] = [];
          fromTokens(item.tokens, inner, depth + 1);
          const [first, ...rest] = inner;
          const runs = first && (first.kind === 'para' || first.kind === 'heading' || first.kind === 'quote') ? first.runs : [];
          const task = item.task ? [{ text: item.checked ? '☑ ' : '☐ ' }] : [];
          out.push({ kind: 'item', ordered: list.ordered, number: Number(list.start || 1) + i, depth, runs: [...task, ...runs] });
          out.push(...(first && runs.length ? rest : inner));
        });
        break;
      }
      case 'table': {
        const table = t as Tokens.Table;
        const cell = (c: Tokens.TableCell) => inline(c.tokens).map((r) => r.text).join('');
        out.push({ kind: 'table', header: true, rows: [table.header.map(cell), ...table.rows.map((r) => r.map(cell))] });
        break;
      }
      case 'hr':
        out.push({ kind: 'rule' });
        break;
      default:
        break; // space, html, def
    }
  }
}

export function markdownToBlocks(md: string): Block[] {
  const out: Block[] = [];
  fromTokens(marked.lexer(md), out);
  return out;
}

/** Plain text: blank lines separate paragraphs; line breaks inside a paragraph are kept. */
export function textToBlocks(text: string): Block[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n(?:[ \t]*\n)+/)
    .filter((p) => p.trim() !== '')
    .map((p) => ({ kind: 'para', runs: [{ text: p.replace(/\n+$/, '') }] }));
}

/** Plain text of runs, e.g. for measuring or for formats without styling. */
export const runsText = (runs: readonly Run[]) => runs.map((r) => r.text).join('');
