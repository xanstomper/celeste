/**
 * Writing documents to disk.
 *
 * `writeDocument` is the single entry point the agent uses: it infers the
 * output format from the file extension, renders the spec and returns an
 * {@link Artifact} describing what was written.
 */

import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, extname } from 'node:path';

import type { Artifact } from '@celeste/protocol';

import { renderCsv } from './csv.js';
import { renderDocx } from './docx.js';
import { renderHtml, renderMarkdown, renderText } from './markdown.js';
import { renderPdf } from './pdf.js';
import { renderPptx } from './pptx.js';
import { asText } from './blocks.js';
import { renderXlsx } from './xlsx.js';
import type {
  DeckSpec,
  DocumentKind,
  DocumentSpec,
  SheetSpec,
  WorkbookSpec,
} from './types.js';

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Infer the output format from a file name.
 * Returns `null` for extensions this package cannot produce.
 */
export function detectKind(filePath: string): DocumentKind | null {
  if (typeof filePath !== 'string' || filePath.length === 0) return null;
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case '.docx':
      return 'docx';
    case '.pdf':
      return 'pdf';
    case '.xlsx':
      return 'xlsx';
    case '.pptx':
      return 'pptx';
    case '.md':
    case '.markdown':
      return 'md';
    case '.html':
    case '.htm':
      return 'html';
    case '.csv':
      return 'csv';
    case '.txt':
      return 'txt';
    default:
      return null;
  }
}

/**
 * Turn a title into a safe file name stem: lowercase, alphanumeric words
 * separated by single dashes, at most 80 characters.
 */
export function slugify(title: string): string {
  if (typeof title !== 'string') return '';
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 80)
    .replace(/-+$/, '');
}

/**
 * Render a spec and write it to `outPath`, creating parent directories as
 * needed. The output format is taken from the file extension.
 */
export async function writeDocument(
  spec: DocumentSpec | WorkbookSpec | DeckSpec | SheetSpec,
  outPath: string,
): Promise<Artifact> {
  if (typeof outPath !== 'string' || outPath.trim().length === 0) {
    throw new Error('writeDocument: an output path is required');
  }
  const kind = detectKind(outPath);
  if (!kind) {
    throw new Error(
      `writeDocument: cannot infer an output format from "${outPath}". ` +
        'Supported extensions: .docx, .pdf, .xlsx, .pptx, .md, .markdown, .html, .htm, .csv, .txt',
    );
  }

  const buffer = await renderSpec(spec, kind);
  const directory = dirname(outPath);
  if (directory && directory !== '.') {
    await mkdir(directory, { recursive: true });
  }
  await writeFile(outPath, buffer);

  const info = await stat(outPath);
  const description = specDescription(spec);

  const artifact: Artifact = {
    path: outPath,
    kind: artifactKind(kind),
    bytes: info.size,
    createdAt: Date.now(),
  };
  if (description) artifact.description = description;
  return artifact;
}

/* -------------------------------------------------------------------------- */
/* Rendering dispatch                                                         */
/* -------------------------------------------------------------------------- */

/** Render any spec in the requested format. */
async function renderSpec(
  spec: DocumentSpec | WorkbookSpec | DeckSpec | SheetSpec,
  kind: DocumentKind,
): Promise<Buffer> {
  switch (kind) {
    case 'docx':
      return renderDocx(toDocumentSpec(spec));
    case 'pdf':
      return renderPdf(toDocumentSpec(spec));
    case 'xlsx':
      return renderXlsx(toWorkbookSpec(spec));
    case 'pptx':
      return renderPptx(toDeckSpec(spec));
    case 'md':
      return Buffer.from(renderMarkdown(toDocumentSpec(spec)), 'utf8');
    case 'html':
      return Buffer.from(renderHtml(toDocumentSpec(spec)), 'utf8');
    case 'csv':
      return Buffer.from(renderCsv(toSheetSpec(spec)), 'utf8');
    case 'txt':
    default:
      return Buffer.from(renderText(toDocumentSpec(spec)), 'utf8');
  }
}

/** Map a {@link DocumentKind} onto the narrower `Artifact` kind union. */
function artifactKind(kind: DocumentKind): Artifact['kind'] {
  switch (kind) {
    case 'docx':
      return 'docx';
    case 'pdf':
      return 'pdf';
    case 'xlsx':
      return 'xlsx';
    case 'pptx':
      return 'pptx';
    case 'md':
      return 'md';
    case 'csv':
      return 'csv';
    case 'txt':
      return 'txt';
    case 'html':
    default:
      return 'other';
  }
}

/** The human readable description of a written artifact. */
function specDescription(spec: unknown): string | undefined {
  if (!spec || typeof spec !== 'object') return undefined;
  const record = spec as Record<string, unknown>;
  for (const key of ['title', 'name'] as const) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Spec coercion                                                              */
/* -------------------------------------------------------------------------- */

/** True when the value looks like a {@link DocumentSpec}. */
function isDocumentSpec(spec: unknown): spec is DocumentSpec {
  return Array.isArray((spec as DocumentSpec | undefined)?.blocks);
}

/** True when the value looks like a {@link WorkbookSpec}. */
function isWorkbookSpec(spec: unknown): spec is WorkbookSpec {
  return Array.isArray((spec as WorkbookSpec | undefined)?.sheets);
}

/** True when the value looks like a {@link DeckSpec}. */
function isDeckSpec(spec: unknown): spec is DeckSpec {
  return Array.isArray((spec as DeckSpec | undefined)?.slides);
}

/** True when the value looks like a {@link SheetSpec}. */
function isSheetSpec(spec: unknown): spec is SheetSpec {
  return Array.isArray((spec as SheetSpec | undefined)?.columns);
}

/** Coerce any spec into a {@link DocumentSpec}. */
export function toDocumentSpec(
  spec: DocumentSpec | WorkbookSpec | DeckSpec | SheetSpec,
): DocumentSpec {
  if (isDocumentSpec(spec)) {
    return {
      ...spec,
      title: spec.title ?? '',
      blocks: spec.blocks ?? [],
    };
  }
  if (isDeckSpec(spec)) {
    const blocks: DocumentSpec['blocks'] = [];
    for (const slide of spec.slides) {
      blocks.push({ type: 'heading', level: 1, text: slide.title });
      for (const bullet of slide.bullets ?? []) {
        blocks.push({ type: 'bullet', text: bullet });
      }
    }
    return { title: spec.title ?? '', subtitle: spec.subtitle, author: spec.author, blocks };
  }
  if (isWorkbookSpec(spec)) {
    const blocks: DocumentSpec['blocks'] = [];
    for (const sheet of spec.sheets) {
      blocks.push({ type: 'heading', level: 1, text: sheet.title ?? sheet.name });
      blocks.push(sheetToTableBlock(sheet));
    }
    return { title: spec.title ?? 'Workbook', blocks };
  }
  if (isSheetSpec(spec)) {
    return {
      title: spec.title ?? spec.name ?? '',
      blocks: [sheetToTableBlock(spec)],
    };
  }
  return { title: '', blocks: [] };
}

/** Coerce any spec into a {@link WorkbookSpec}. */
export function toWorkbookSpec(
  spec: DocumentSpec | WorkbookSpec | DeckSpec | SheetSpec,
): WorkbookSpec {
  if (isWorkbookSpec(spec)) {
    return { ...spec, sheets: spec.sheets ?? [] };
  }
  if (isSheetSpec(spec)) {
    return { title: spec.title ?? spec.name, sheets: [spec] };
  }
  if (isDocumentSpec(spec)) {
    const sheets: SheetSpec[] = [];
    for (const block of spec.blocks ?? []) {
      if (block.type !== 'table' || !block.table) continue;
      sheets.push(tableBlockToSheet(block.table, `Sheet${sheets.length + 1}`));
    }
    return { title: spec.title, author: spec.author, sheets };
  }
  if (isDeckSpec(spec)) {
    const sheet: SheetSpec = {
      name: 'Slides',
      columns: [
        { header: 'Slide', key: 'slide' },
        { header: 'Content', key: 'content' },
      ],
      rows: spec.slides.map((slide, index) => ({
        slide: `${index + 1}. ${slide.title}`,
        content: (slide.bullets ?? []).join('\n'),
      })),
    };
    return { title: spec.title, author: spec.author, sheets: [sheet] };
  }
  return { sheets: [] };
}

/** Coerce any spec into a {@link DeckSpec}. */
export function toDeckSpec(
  spec: DocumentSpec | WorkbookSpec | DeckSpec | SheetSpec,
): DeckSpec {
  if (isDeckSpec(spec)) {
    return { ...spec, slides: spec.slides ?? [] };
  }
  if (isDocumentSpec(spec)) {
    const slides: DeckSpec['slides'] = [];
    let current: { title: string; bullets: string[] } | null = null;
    for (const block of spec.blocks ?? []) {
      if (block.type === 'heading') {
        if (current) slides.push({ title: current.title, bullets: current.bullets });
        current = { title: block.text ?? '', bullets: [] };
      } else if (block.type === 'bullet' && current) {
        current.bullets.push(block.text ?? '');
      }
    }
    if (current) slides.push({ title: current.title, bullets: current.bullets });
    return { title: spec.title, subtitle: spec.subtitle, author: spec.author, slides };
  }
  if (isSheetSpec(spec)) {
    return {
      title: spec.title ?? spec.name ?? '',
      slides: [{ title: spec.title ?? spec.name ?? 'Sheet', bullets: [] }],
    };
  }
  if (isWorkbookSpec(spec)) {
    return {
      title: spec.title ?? 'Workbook',
      slides: spec.sheets.map((sheet) => ({
        title: sheet.title ?? sheet.name,
        bullets: [],
      })),
    };
  }
  return { title: '', slides: [] };
}

/** Coerce any spec into a {@link SheetSpec}. */
export function toSheetSpec(
  spec: DocumentSpec | WorkbookSpec | DeckSpec | SheetSpec,
): SheetSpec {
  if (isSheetSpec(spec)) {
    return { ...spec, columns: spec.columns ?? [], rows: spec.rows ?? [] };
  }
  if (isWorkbookSpec(spec)) {
    const first = spec.sheets[0];
    if (first) return first;
    return { name: 'Sheet1', columns: [], rows: [] };
  }
  if (isDocumentSpec(spec)) {
    for (const block of spec.blocks ?? []) {
      if (block.type === 'table' && block.table) {
        return tableBlockToSheet(block.table, 'Sheet1');
      }
    }
    return { name: 'Sheet1', columns: [], rows: [] };
  }
  return { name: 'Sheet1', columns: [], rows: [] };
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

/** Turn a table block into a sheet. */
function tableBlockToSheet(
  table: NonNullable<DocumentSpec['blocks'][number]['table']>,
  name: string,
): SheetSpec {
  const headers = table.headers ?? [];
  const columns = headers.map((header, index) => ({
    header,
    key: `column${index + 1}`,
  }));
  const rows = (table.rows ?? []).map((row) => {
    const record: Record<string, unknown> = {};
    columns.forEach((column, index) => {
      record[column.key] = row[index] ?? '';
    });
    return record;
  });
  return { name, columns, rows };
}

/** Turn a sheet into a table block. */
function sheetToTableBlock(sheet: SheetSpec): DocumentSpec['blocks'][number] {
  const columns = sheet.columns ?? [];
  const headers = columns.map((column) => column.header ?? column.key ?? '');
  const rows = (sheet.rows ?? []).map((row) =>
    columns.map((column) => asText(row ? row[column.key] : undefined)),
  );
  return { type: 'table', table: { type: 'table', headers, rows } };
}
