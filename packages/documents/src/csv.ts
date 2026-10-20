/**
 * CSV renderer (RFC 4180).
 *
 * Fields are quoted when they contain a comma, a double quote, a carriage
 * return or a line feed; embedded quotes are doubled. Records are separated
 * by CRLF, as the RFC prescribes.
 */

import { asText } from './blocks.js';
import type { SheetSpec } from './types.js';

/**
 * Render a {@link SheetSpec} as CSV.
 *
 * The header row comes from `sheet.columns`; the data rows are read from each
 * record's column key.
 */
export function renderCsv(sheet: SheetSpec): string {
  const columns = Array.isArray(sheet?.columns) ? sheet.columns : [];
  const rows = Array.isArray(sheet?.rows) ? sheet.rows : [];

  const lines: string[] = [];
  lines.push(columns.map((column) => quoteField(column.header ?? column.key ?? '')).join(','));

  for (const record of rows) {
    const cells = columns.map((column) => {
      const value = record ? record[column.key] : undefined;
      return quoteField(asText(value));
    });
    lines.push(cells.join(','));
  }

  return `${lines.join('\r\n')}\r\n`;
}

/** Quote a single field according to RFC 4180. */
function quoteField(value: string): string {
  const text = value ?? '';
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}
