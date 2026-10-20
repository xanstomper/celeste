import { Fragment, type ReactNode } from 'react';

/**
 * A small Markdown renderer.
 *
 * The models write Markdown; Perplexity renders it. This handles the subset
 * that actually shows up in an assistant answer: inline emphasis, inline code,
 * links, bullet and numbered lists, block quotes, fenced code and paragraphs.
 * Everything is rendered as React elements, never as raw HTML.
 */

type Block =
  | { kind: 'p'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; text: string; lang?: string }
  | { kind: 'hr' };

/** Splits a document into blocks. */
export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    // Fenced code.
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] || undefined;
      const body: string[] = [];
      index++;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index] ?? '')) {
        body.push(lines[index] ?? '');
        index++;
      }
      index++; // closing fence
      blocks.push({ kind: 'code', text: body.join('\n'), ...(lang ? { lang } : {}) });
      continue;
    }

    // Horizontal rule.
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ kind: 'hr' });
      index++;
      continue;
    }

    // Block quote.
    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index] ?? '')) {
        body.push((lines[index] ?? '').replace(/^\s*>\s?/, ''));
        index++;
      }
      blocks.push({ kind: 'quote', text: body.join('\n') });
      continue;
    }

    // Unordered list.
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index] ?? '')) {
        items.push((lines[index] ?? '').replace(/^\s*[-*+]\s+/, ''));
        index++;
      }
      blocks.push({ kind: 'ul', items });
      continue;
    }

    // Ordered list.
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index] ?? '')) {
        items.push((lines[index] ?? '').replace(/^\s*\d+[.)]\s+/, ''));
        index++;
      }
      blocks.push({ kind: 'ol', items });
      continue;
    }

    // Blank line.
    if (!line.trim()) {
      index++;
      continue;
    }

    // Paragraph: consume until a blank line or the start of another block.
    const body: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? '';
      if (
        !current.trim() ||
        /^\s*(```|>|[-*+]\s|\d+[.)]\s)/.test(current)
      ) {
        break;
      }
      body.push(current);
      index++;
    }
    blocks.push({ kind: 'p', text: body.join('\n') });
  }

  return blocks;
}

/* -------------------------------------------------------------------------- */
/* Inline rendering                                                           */
/* -------------------------------------------------------------------------- */

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]]+\]\([^)\s]+\))/;

/** Renders inline Markdown — code, bold, italic and links. */
export function renderInline(text: string, keyPrefix = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let n = 0;

  while (rest.length > 0) {
    const match = INLINE.exec(rest);
    if (!match || match.index === undefined) {
      out.push(rest);
      break;
    }
    if (match.index > 0) out.push(rest.slice(0, match.index));

    const token = match[0];
    const key = `${keyPrefix}-${n++}`;

    if (token.startsWith('`')) {
      out.push(
        <code className="md__code" key={key}>
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('**') || token.startsWith('__')) {
      out.push(
        <strong key={key}>
          {renderInline(token.slice(2, -2), `${key}-b`)}
        </strong>,
      );
    } else if (token.startsWith('[')) {
      const link = /\[([^\]]+)\]\(([^)\s]+)\)/.exec(token);
      const label = link?.[1] ?? token;
      const href = link?.[2] ?? '#';
      const external = /^https?:\/\//i.test(href);
      out.push(
        <a
          className="md__link"
          key={key}
          href={href}
          {...(external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
        >
          {label}
        </a>,
      );
    } else {
      out.push(
        <em key={key}>
          {renderInline(token.slice(1, -1), `${key}-i`)}
        </em>,
      );
    }

    rest = rest.slice(match.index + token.length);
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Component                                                                  */
/* -------------------------------------------------------------------------- */

export interface MarkdownProps {
  content: string;
  className?: string;
}

/** Renders a Markdown document as React elements. */
export function Markdown({ content, className }: MarkdownProps): ReactNode {
  const blocks = parseBlocks(content ?? '');

  if (blocks.length === 0) {
    return null;
  }

  return (
    <div className={className ? `md ${className}` : 'md'}>
      {blocks.map((block, index) => {
        const key = `b${index}`;
        switch (block.kind) {
          case 'p':
            return (
              <p className="md__p" key={key}>
                {renderInline(block.text, key)}
              </p>
            );
          case 'ul':
            return (
              <ul className="md__ul" key={key}>
                {block.items.map((item, i) => (
                  <li key={`${key}-${i}`}>{renderInline(item, `${key}-${i}`)}</li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol className="md__ol" key={key}>
                {block.items.map((item, i) => (
                  <li key={`${key}-${i}`}>{renderInline(item, `${key}-${i}`)}</li>
                ))}
              </ol>
            );
          case 'quote':
            return (
              <blockquote className="md__quote" key={key}>
                {renderInline(block.text, key)}
              </blockquote>
            );
          case 'code':
            return (
              <pre className="md__pre" key={key}>
                {block.lang ? <span className="md__lang">{block.lang}</span> : null}
                <code>{block.text}</code>
              </pre>
            );
          case 'hr':
            return <hr className="md__hr" key={key} />;
          default:
            return <Fragment key={key} />;
        }
      })}
    </div>
  );
}
