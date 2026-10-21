import { describe, expect, it } from 'vitest';

import { extractPdfText } from '../src/read-pdf.js';

/**
 * A hand-built PDF, so the test needs no fixture file and no network.
 *
 * The content stream is uncompressed, which is exactly the shape the
 * extractor falls back to when a stream is not Flate-encoded.
 */
function buildPdf(lines: string[]): Buffer {
  const content = ['BT', '/F1 12 Tf', '72 720 Td'];
  for (const line of lines) content.push(`(${line}) Tj`, '0 -16 Td');
  content.push('ET');
  const body = content.join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;

  return Buffer.from(pdf, 'latin1');
}

describe('extractPdfText', () => {
  it('reads the text out of a simple document', () => {
    const pdf = buildPdf(['Hello Celeste', 'Second line of the report']);
    const result = extractPdfText(pdf);

    expect(result.text).toContain('Hello Celeste');
    expect(result.text).toContain('Second line of the report');
    expect(result.pages).toBe(1);
    expect(result.readable).toBe(true);
  });

  it('says a document is unreadable rather than returning noise', () => {
    // A PDF with no content stream at all.
    const empty = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF', 'latin1');
    const result = extractPdfText(empty);

    expect(result.text).toBe('');
    expect(result.readable).toBe(false);
  });

  it('never returns more than the cap', () => {
    const many = Array.from({ length: 4000 }, (_, index) => `line ${index} of a very long document`);
    const result = extractPdfText(buildPdf(many));

    expect(result.text.length).toBeLessThanOrEqual(120_000);
  });
});
