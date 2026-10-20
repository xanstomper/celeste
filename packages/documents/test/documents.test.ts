import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  detectKind,
  parseImageSize,
  renderCsv,
  renderDocx,
  renderHtml,
  renderMarkdown,
  renderPdf,
  renderPptx,
  renderXlsx,
  slugify,
  writeDocument,
} from '../src/index.js';
import type { DeckSpec, DocumentSpec, WorkbookSpec } from '../src/index.js';

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const PDF_MAGIC = Buffer.from('%PDF', 'latin1');

const richSpec: DocumentSpec = {
  title: 'Celeste Report',
  subtitle: 'A subtitle',
  author: 'Celeste Agent',
  date: '2026-10-20T00:00:00.000Z',
  theme: { accentColor: '4F46E5', headerText: 'Header', footerText: 'Footer' },
  blocks: [
    { type: 'heading', level: 1, text: 'Heading' },
    { type: 'paragraph', text: 'A paragraph.' },
    { type: 'bullet', text: 'Bullet' },
    { type: 'numbered', text: 'Numbered' },
    { type: 'code', language: 'ts', text: 'const x = 1;' },
    { type: 'quote', text: 'A quote', attribution: 'Someone' },
    {
      type: 'table',
      table: {
        type: 'table',
        headers: ['A', 'B'],
        rows: [['1', '2']],
      },
    },
    {
      type: 'keyvalue',
      keyvalue: { type: 'keyvalue', entries: [{ key: 'k', value: 'v' }] },
    },
    { type: 'divider' },
    { type: 'pagebreak' },
  ],
};

const workbookSpec: WorkbookSpec = {
  title: 'Metrics',
  author: 'Celeste',
  sheets: [
    {
      name: 'Sheet One',
      title: 'Sheet title',
      columns: [
        { header: 'Name', key: 'name' },
        { header: 'Count', key: 'count', type: 'number' },
      ],
      rows: [{ name: 'a', count: 1 }],
    },
    { name: 'Sheet One', columns: [{ header: 'X', key: 'x' }], rows: [{ x: 'y' }] },
  ],
};

const deckSpec: DeckSpec = {
  title: 'Deck',
  subtitle: 'Subtitle',
  author: 'Celeste',
  slides: [
    { title: 'One', bullets: ['a', 'b'], notes: 'notes' },
    { title: 'Two', layout: 'section' },
    { title: 'Three', bullets: ['c'], bulletsRight: ['d'] },
  ],
};

let workDir = '';

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'celeste-documents-'));
});

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

describe('detectKind', () => {
  it('maps every supported extension', () => {
    expect(detectKind('a.docx')).toBe('docx');
    expect(detectKind('a.pdf')).toBe('pdf');
    expect(detectKind('a.xlsx')).toBe('xlsx');
    expect(detectKind('a.pptx')).toBe('pptx');
    expect(detectKind('a.md')).toBe('md');
    expect(detectKind('a.markdown')).toBe('md');
    expect(detectKind('a.html')).toBe('html');
    expect(detectKind('a.htm')).toBe('html');
    expect(detectKind('a.csv')).toBe('csv');
    expect(detectKind('a.txt')).toBe('txt');
  });

  it('is case-insensitive and rejects unknown extensions', () => {
    expect(detectKind('A.DOCX')).toBe('docx');
    expect(detectKind('a.zip')).toBeNull();
    expect(detectKind('noextension')).toBeNull();
    expect(detectKind('')).toBeNull();
  });
});

describe('slugify', () => {
  it('lowercases and dashes', () => {
    expect(slugify('Hello, World!')).toBe('hello-world');
    expect(slugify('  spaced  out  ')).toBe('spaced-out');
    expect(slugify('---')).toBe('');
  });

  it('truncates to 80 characters', () => {
    expect(slugify('a'.repeat(200))).toHaveLength(80);
    expect(slugify(`${'a'.repeat(90)} tail`)).not.toMatch(/-$/);
  });
});

describe('markdown', () => {
  it('renders every block type', () => {
    const markdown = renderMarkdown(richSpec);
    expect(markdown).toContain('# Celeste Report');
    expect(markdown).toContain('# Heading');
    expect(markdown).toContain('- Bullet');
    expect(markdown).toContain('1. Numbered');
    expect(markdown).toContain('```ts');
    expect(markdown).toContain('> A quote');
    expect(markdown).toContain('| A | B |');
    expect(markdown).toContain('**k**: v');
    expect(markdown).toContain('---');
  });

  it('handles an empty spec', () => {
    expect(() => renderMarkdown({ title: '', blocks: [] })).not.toThrow();
  });
});

describe('html', () => {
  it('is a self-contained document', () => {
    const html = renderHtml(richSpec);
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<style>');
    expect(html).toContain('<table>');
    expect(html).not.toMatch(/<link[^>]+href="http/);
  });

  it('handles an empty spec', () => {
    expect(() => renderHtml({ title: '', blocks: [] })).not.toThrow();
  });
});

describe('csv', () => {
  it('quotes per RFC 4180', () => {
    const csv = renderCsv({
      name: 's',
      columns: [
        { header: 'plain', key: 'a' },
        { header: 'tricky', key: 'b' },
      ],
      rows: [{ a: 'x', b: 'has, comma and "quotes"' }],
    });
    expect(csv).toBe(
      'plain,tricky\r\nx,"has, comma and ""quotes"""\r\n',
    );
  });
});

describe('office renderers', () => {
  it('produces a real docx', async () => {
    const buffer = await renderDocx(richSpec);
    expect(buffer.subarray(0, 4)).toEqual(ZIP_MAGIC);
  });

  it('produces a real pdf', async () => {
    const buffer = await renderPdf(richSpec);
    expect(buffer.subarray(0, 4)).toEqual(PDF_MAGIC);
  });

  it('produces a real xlsx', async () => {
    const buffer = await renderXlsx(workbookSpec);
    expect(buffer.subarray(0, 4)).toEqual(ZIP_MAGIC);
  });

  it('produces a real pptx', async () => {
    const buffer = await renderPptx(deckSpec);
    expect(buffer.subarray(0, 4)).toEqual(ZIP_MAGIC);
  });

  it('survives empty specs', async () => {
    await expect(renderDocx({ title: '', blocks: [] })).resolves.toBeTruthy();
    await expect(renderPdf({ title: '', blocks: [] })).resolves.toBeTruthy();
    await expect(renderXlsx({ sheets: [] })).resolves.toBeTruthy();
    await expect(renderPptx({ title: '', slides: [] })).resolves.toBeTruthy();
  });
});

describe('image helpers', () => {
  it('reads PNG dimensions from the IHDR chunk', () => {
    // 1x1 transparent PNG.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    expect(parseImageSize(png)).toEqual({ width: 1, height: 1 });
  });

  it('returns null for unknown data', () => {
    expect(parseImageSize(Buffer.from('not an image'))).toBeNull();
  });
});

describe('writeDocument', () => {
  it('writes every format and returns an artifact', async () => {
    const targets: [Parameters<typeof writeDocument>[0], string][] = [
      [richSpec, 'report.docx'],
      [richSpec, 'report.pdf'],
      [richSpec, 'report.md'],
      [richSpec, 'report.html'],
      [richSpec, 'report.txt'],
      [workbookSpec, 'book.xlsx'],
      [deckSpec, 'deck.pptx'],
      [workbookSpec.sheets[0]!, 'sheet.csv'],
    ];

    for (const [spec, name] of targets) {
      const target = path.join(workDir, name);
      const artifact = await writeDocument(spec, target);
      const info = await stat(target);
      expect(info.size).toBeGreaterThan(0);
      expect(artifact.path).toBe(target);
      expect(artifact.bytes).toBe(info.size);
      expect(artifact.createdAt).toBeGreaterThan(0);
      expect(artifact.description).toBeTruthy();
    }
  });

  it('creates missing parent directories', async () => {
    const target = path.join(workDir, 'deep', 'nested', 'report.pdf');
    await writeDocument(richSpec, target);
    const buffer = await readFile(target);
    expect(buffer.subarray(0, 4)).toEqual(PDF_MAGIC);
  });

  it('rejects unknown extensions', async () => {
    await expect(writeDocument(richSpec, path.join(workDir, 'report.zip'))).rejects.toThrow();
  });
});
