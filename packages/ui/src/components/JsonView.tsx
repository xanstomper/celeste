/**
 * A dependency free, syntax highlighted JSON viewer.
 *
 * It pretty prints the value and then runs a tiny hand written tokenizer over
 * the result, emitting one `<span>` per lexical token. The theme colours live
 * in CSS (`--json-key`, `--json-string`, ...) so the highlighter itself stays
 * free of presentation concerns.
 */

import { useMemo } from 'react';

type TokenType = 'key' | 'string' | 'number' | 'boolean' | 'null' | 'punct' | 'space';

interface Token {
  type: TokenType;
  value: string;
}

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r';
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

/**
 * Splits pretty printed JSON into lexical tokens.
 */
export function tokenizeJson(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    const ch = source.charAt(index);

    if (ch === '"') {
      let end = index + 1;
      while (end < source.length) {
        const current = source.charAt(end);
        if (current === '\\') {
          end += 2;
          continue;
        }
        end += 1;
        if (current === '"') break;
      }
      const raw = source.slice(index, end);
      let lookahead = end;
      while (lookahead < source.length && isSpace(source.charAt(lookahead))) lookahead += 1;
      const isKey = source.charAt(lookahead) === ':';
      tokens.push({ type: isKey ? 'key' : 'string', value: raw });
      index = end;
      continue;
    }

    if (isSpace(ch)) {
      let end = index;
      while (end < source.length && isSpace(source.charAt(end))) end += 1;
      tokens.push({ type: 'space', value: source.slice(index, end) });
      index = end;
      continue;
    }

    if (ch === '-' || isDigit(ch)) {
      let end = index + 1;
      while (end < source.length) {
        const current = source.charAt(end);
        if (isDigit(current) || current === '.' || current === 'e' || current === 'E' || current === '+' || current === '-') {
          end += 1;
          continue;
        }
        break;
      }
      tokens.push({ type: 'number', value: source.slice(index, end) });
      index = end;
      continue;
    }

    if (source.startsWith('true', index)) {
      tokens.push({ type: 'boolean', value: 'true' });
      index += 4;
      continue;
    }

    if (source.startsWith('false', index)) {
      tokens.push({ type: 'boolean', value: 'false' });
      index += 5;
      continue;
    }

    if (source.startsWith('null', index)) {
      tokens.push({ type: 'null', value: 'null' });
      index += 4;
      continue;
    }

    tokens.push({ type: 'punct', value: ch });
    index += 1;
  }

  return tokens;
}

/**
 * Maps a lexical token to its CSS class. Kept as a literal table (rather than
 * a template string) so the class names stay greppable in the bundle.
 */
const TOKEN_CLASS: Record<TokenType, string> = {
  key: 'tok-key',
  string: 'tok-string',
  number: 'tok-number',
  boolean: 'tok-boolean',
  null: 'tok-null',
  punct: 'tok-punct',
  space: 'tok-space',
};

export interface JsonViewProps {
  value: unknown;
  /** Optional cap so huge payloads do not blow up the timeline. */
  maxHeight?: number;
  className?: string;
  emptyLabel?: string;
}

export function JsonView({ value, maxHeight, className, emptyLabel }: JsonViewProps) {
  const tokens = useMemo(() => {
    if (value === undefined) return [] as Token[];
    let text: string;
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
    if (text === undefined) return [] as Token[];
    return tokenizeJson(text);
  }, [value]);

  if (tokens.length === 0) {
    return <p className="json-view json-view--empty">{emptyLabel ?? 'No payload'}</p>;
  }

  const style = maxHeight ? { maxHeight } : undefined;

  return (
    <pre className={`json-view${className ? ` ${className}` : ''}`} style={style}>
      {tokens.map((token, index) =>
        token.type === 'space' ? (
          token.value
        ) : (
          <span key={index} className={`tok ${TOKEN_CLASS[token.type]}`}>
            {token.value}
          </span>
        ),
      )}
    </pre>
  );
}
