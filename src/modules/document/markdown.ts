/**
 * Markdown and plain text conversions. `marked` parses Markdown (GitHub
 * flavoured: tables, task lists, strikethrough).
 */
import { Marked, type Token, type Tokens } from 'marked';
import { escapeHtml, htmlDocument } from './table';

const marked = new Marked({ gfm: true });

export function markdownToHtml(md: string, title: string): string {
  return htmlDocument(title, marked.parse(md, { async: false }));
}

/** Plain text of inline tokens: formatting markers dropped, link text kept. */
function inlineText(tokens: Token[] | undefined, fallback = ''): string {
  if (!tokens) return fallback;
  return tokens
    .map((t) => {
      if (t.type === 'br') return '\n';
      if (t.type === 'image') return (t as Tokens.Image).text;
      if ('tokens' in t && t.tokens) return inlineText(t.tokens);
      if (t.type === 'escape' || t.type === 'text' || t.type === 'codespan') return decodeEntities((t as Tokens.Text).text);
      if (t.type === 'html') return '';
      return 'text' in t ? String(t.text) : '';
    })
    .join('');
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const decodeEntities = (s: string) => s.replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m]!);

function blockText(tokens: Token[], indent = ''): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'heading':
      case 'paragraph':
        out.push(indent + inlineText((t as Tokens.Heading).tokens, (t as Tokens.Heading).text), '');
        break;
      case 'code':
        out.push(...(t as Tokens.Code).text.split('\n').map((l) => indent + l), '');
        break;
      case 'blockquote':
        out.push(...blockText((t as Tokens.Blockquote).tokens, `${indent}> `));
        break;
      case 'list': {
        const list = t as Tokens.List;
        list.items.forEach((item, i) => {
          const marker = list.ordered ? `${Number(list.start || 1) + i}. ` : '- ';
          const lines = blockText(item.tokens, '').filter((l, n, all) => l !== '' || n < all.length - 1);
          lines.forEach((l, n) => out.push(indent + (n === 0 ? marker : ' '.repeat(marker.length)) + l));
        });
        out.push('');
        break;
      }
      case 'table': {
        const table = t as Tokens.Table;
        out.push(indent + table.header.map((c) => inlineText(c.tokens, c.text)).join('\t'));
        for (const row of table.rows) out.push(indent + row.map((c) => inlineText(c.tokens, c.text)).join('\t'));
        out.push('');
        break;
      }
      case 'hr':
        out.push(indent + '----', '');
        break;
      case 'text':
        out.push(indent + inlineText((t as Tokens.Text).tokens, (t as Tokens.Text).text));
        break;
      default:
        break; // space, html, def
    }
  }
  return out;
}

/** Markdown to readable plain text: structure kept, markup removed. */
export function markdownToText(md: string): string {
  const lines = blockText(marked.lexer(md));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** Plain text as an HTML page: blank lines separate paragraphs, line breaks are kept. */
export function textToHtml(text: string, title: string): string {
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .filter((p) => p.trim() !== '')
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>\n')}</p>`);
  return htmlDocument(title, paragraphs.join('\n'));
}

/**
 * Plain text as Markdown that renders the same: characters that Markdown
 * would treat as formatting are escaped, and single line breaks are kept.
 */
export function textToMarkdown(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const escaped = lines.map((l) =>
    l
      .replace(/([\\`*_[\]<>])/g, '\\$1')
      .replace(/^(\s*)([#>+-])(?=\s|$)/, '$1\\$2')
      .replace(/^(\s*\d+)\.(?=\s|$)/, '$1\\.')
      .replace(/^(\s*)(={3,}|-{3,})\s*$/, '$1\\$2'),
  );
  // A line followed by another non-empty line needs a hard break ("\" at the end).
  return escaped.map((l, i) => (l.trim() !== '' && (escaped[i + 1] ?? '').trim() !== '' ? `${l}\\` : l)).join('\n').replace(/\n*$/, '\n');
}
