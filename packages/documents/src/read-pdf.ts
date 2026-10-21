import { inflateSync } from 'node:zlib';

/**
 * Reading text out of a PDF.
 *
 * A PDF stores its text in content streams: a list of drawing operators
 * (`Tj`, `TJ`, `T*`) wrapped around literal strings. This module inflates
 * those streams and pulls the strings back out, which is enough for the
 * majority of text PDFs - the ones a reader would open and copy from.
 *
 * It is deliberately dependency-free: no parser, no native bindings, no
 * network. When a file is too exotic to read, the caller is told so rather
 * than being handed gibberish.
 */

export interface ExtractedPdf {
  /** The text, paragraphs separated by blank lines. */
  text: string;
  /** How many pages the file claims to have. */
  pages: number;
  /** False when the file is image-only or uses an encoding we cannot read. */
  readable: boolean;
}

/** The most text we will take from one file. */
const MAX_TEXT = 120_000;

/** Decodes a PDF literal string, including its escapes. */
function decodeLiteral(body: string): string {
  let text = '';
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== '\\') {
      text += char ?? '';
      continue;
    }
    const next = body[index + 1] ?? '';
    index += 1;
    switch (next) {
      case 'n':
        text += '\n';
        break;
      case 'r':
        text += '\r';
        break;
      case 't':
        text += '\t';
        break;
      case 'b':
        text += '\b';
        break;
      case 'f':
        text += '\f';
        break;
      case '(':
        text += '(';
        break;
      case ')':
        text += ')';
        break;
      case '\\':
        text += '\\';
        break;
      case '\n':
        break;
      case '\r':
        if (body[index + 1] === '\n') index += 1;
        break;
      default: {
        if (next && next >= '0' && next <= '7') {
          let octal = next;
          while (octal.length < 3) {
            const digit = body[index + 1];
            if (digit === undefined || digit < '0' || digit > '7') break;
            index += 1;
            octal += digit;
          }
          text += String.fromCharCode(parseInt(octal, 8));
        } else {
          text += next ?? '';
        }
      }
    }
  }
  return text;
}

/** Pulls the visible strings out of one content stream. */
function textFromContent(content: string): string {
  let out = '';
  let index = 0;
  const length = content.length;

  while (index < length) {
    const char = content[index] ?? '';

    // A literal string: ( ... ) with escapes.
    if (char === '(') {
      let depth = 0;
      let cursor = index;
      let raw = '';
      while (cursor < length) {
        const current = content[cursor] ?? '';
        if (current === '\\') {
          raw += current + (content[cursor + 1] ?? '');
          cursor += 2;
          continue;
        }
        if (current === '(') depth += 1;
        raw += current ?? '';
        cursor += 1;
        if (current === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      out += decodeLiteral(raw.slice(1, -1));
      index = cursor;
      continue;
    }

    // A hex string: <48656C6C6F>
    if (char === '<' && content[index + 1] !== '<') {
      const end = content.indexOf('>', index);
      if (end > 0) {
        const hex = content.slice(index + 1, end).replace(/\s+/g, '');
        let text = '';
        for (let position = 0; position + 1 < hex.length; position += 2) {
          const code = parseInt(hex.slice(position, position + 2), 16);
          if (code === 9 || code === 10 || code >= 32) text += String.fromCharCode(code);
        }
        out += text;
        index = end + 1;
        continue;
      }
    }

    // Operators.
    if (/[A-Za-z'"*]/.test(char)) {
      let cursor = index;
      while (cursor < length && /[A-Za-z0-9*'"]/.test(content[cursor] ?? '')) cursor += 1;
      const operator = content.slice(index, cursor) ?? '';
      index = cursor;
      if (operator === 'T*' || operator === 'ET' || operator === 'Td' || operator === 'TD') {
        out += '\n';
      }
      continue;
    }

    index += 1;
  }

  return out;
}

/**
 * Extracts the text of a PDF.
 *
 * @param input The raw file bytes.
 */
export function extractPdfText(input: Buffer): ExtractedPdf {
  const raw = input.toString('latin1');

  const pageMatches = raw.match(/\/Type\s*\/Page[^s]/g);
  const pages = pageMatches ? pageMatches.length : 0;

  const chunks: string[] = [];
  const streamPattern = /stream\r?\n?([\s\S]*?)\r?\n?endstream/g;
  let match: RegExpExecArray | null;
  while ((match = streamPattern.exec(raw)) !== null) {
    const body = Buffer.from(match[1] ?? '', 'latin1');
    let content: Buffer;
    try {
      content = inflateSync(body);
    } catch {
      // Not compressed: the bytes are the content.
      content = body;
    }
    const text = textFromContent(content.toString('latin1'));
    if (text.trim().length > 0) chunks.push(text);
  }

  const text = chunks
    .join('\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // A file that yields almost nothing is either scanned or uses an
  // encoding we cannot read. Say so instead of pretending.
  const readable = text.replace(/[^\w\s]/g, '').trim().length >= 20;

  return { text: text.slice(0, MAX_TEXT), pages, readable };
}
