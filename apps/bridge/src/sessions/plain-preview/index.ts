import { Lexer, type Token, type Tokens } from 'marked';
import { decodeHTML } from 'entities';
import { stripTranscriptMarkup } from '../support/activity-helpers';

function inline(tokens: readonly Token[]): string {
  return tokens.map(readToken).join('');
}

function children(token: Token): string {
  if ('tokens' in token && Array.isArray(token.tokens)) return inline(token.tokens);
  return 'text' in token ? String(token.text) : '';
}

function tableText(token: Tokens.Table): string {
  return [token.header, ...token.rows].map(row =>
    row.map(cell => inline(cell.tokens)).join(' | ')).join('\n') + '\n';
}

/** Read text from parsed tokens, never rendered HTML or executable content. */
function readToken(token: Token): string {
  switch (token.type) {
    case 'space': case 'br': case 'hr': return '\n';
    case 'def': return '';
    case 'table': return tableText(token as Tokens.Table);
    case 'list': return '\n' + (token as Tokens.List).items.map(item => inline(item.tokens)).join('\n') + '\n';
    case 'paragraph': case 'heading': case 'blockquote': return children(token) + '\n';
    case 'code': return String(token.text) + '\n';
    case 'codespan': case 'escape': return String(token.text);
    case 'html': return decodeHTML(String(token.text).replace(/<[^>]*>/g, ''));
    case 'text': case 'image':
      return 'tokens' in token && Array.isArray(token.tokens) ? inline(token.tokens) : decodeHTML(String(token.text));
    default: return children(token);
  }
}

/** Catalog summaries are display text. Parse complete Markdown before shortening it. */
export function plainPreview(value: unknown, limit = 160): string | undefined {
  const source = stripTranscriptMarkup(value);
  const visible = inline(Lexer.lex(source, { gfm: true })).replace(/\s+/g, ' ').trim();
  return visible ? Array.from(visible).slice(0, limit).join('') : undefined;
}
