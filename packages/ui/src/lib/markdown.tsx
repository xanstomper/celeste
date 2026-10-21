import { Fragment, type ReactNode } from 'react';

import type { CitationRef } from './citations';

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
  | { kind: 'heading'; level: number; text: string }
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

    // Heading. Models lean on these heavily; rendering them as paragraphs
    // left literal "##" in the middle of answers.
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]! });
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
        /^\s*(```|>|[-*+]\s|\d+[.)]\s|#{1,6}\s)/.test(current)
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

const INLINE =
  /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]]+\]\([^)\s]+\))|(\[\d{1,3}(?:\s*,\s*\d{1,3})*\])/;

/** Renders inline Markdown — code, bold, italic, links and citations. */
export function renderInline(
  text: string,
  keyPrefix = 'i',
  citations?: Map<number, CitationRef>,
): ReactNode[] {
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
          {renderInline(token.slice(2, -2), `${key}-b`, citations)}
        </strong>,
      );
    } else if (/^\[\d/.test(token)) {
      // A citation: [3] or [1, 4].
      const numbers = token
        .slice(1, -1)
        .split(',')
        .map((part) => Number(part.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
      out.push(
        <span className="md__cites" key={key}>
          {numbers.map((n, index) => {
            const ref = citations?.get(n);
            return ref ? (
              <a
                className="md__cite"
                key={`${key}-${n}-${index}`}
                href={ref.source.url}
                target="_blank"
                rel="noreferrer noopener"
                title={ref.source.title}
              >
                {ref.display}
              </a>
            ) : (
              <span className="md__cite md__cite--plain" key={`${key}-${n}-${index}`}>
                {n}
              </span>
            );
          })}
        </span>,
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
          {renderInline(token.slice(1, -1), `${key}-i`, citations)}
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
  /** Resolves `[n]` markers to real pages. */
  citations?: Map<number, CitationRef>;
  /**
   * Rendered inside the prose, before the first block.
   *
   * Used for the small teal glyph that sits at the left of the first line of
   * an answer - a float, so only the first line is indented.
   */
  lead?: ReactNode;
}

/** Renders a Markdown document as React elements. */
export function Markdown({ content, className, citations, lead }: MarkdownProps): ReactNode {
  const blocks = parseBlocks(content ?? '');

  if (blocks.length === 0) {
    return null;
  }

  return (
    <div className={className ? `md ${className}` : 'md'}>
      {lead}
      {blocks.map((block, index) => {
        const key = `b${index}`;
        switch (block.kind) {
          case 'p':
            return (
              <p className="md__p" key={key}>
                {renderInline(block.text, key, citations)}
              </p>
            );
          case 'heading': {
            const content = renderInline(block.text, key, citations);
            if (block.level === 1) {
              return (
                <h1 className="md__h1" key={key}>
                  {content}
                </h1>
              );
            }
            if (block.level === 2) {
              return (
                <h2 className="md__h2" key={key}>
                  {content}
                </h2>
              );
            }
            return (
              <h3 className="md__h3" key={key}>
                {content}
              </h3>
            );
          }
          case 'ul':
            return (
              <ul className="md__ul" key={key}>
                {block.items.map((item, i) => (
                  <li key={`${key}-${i}`}>{renderInline(item, `${key}-${i}`, citations)}</li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol className="md__ol" key={key}>
                {block.items.map((item, i) => (
                  <li key={`${key}-${i}`}>{renderInline(item, `${key}-${i}`, citations)}</li>
                ))}
              </ol>
            );
          case 'quote':
            return (
              <blockquote className="md__quote" key={key}>
                {renderInline(block.text, key, citations)}
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
