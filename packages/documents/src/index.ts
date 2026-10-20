/**
 * @celeste/documents — document generation pipelines for Celeste.
 *
 * The agent emits a structured spec (JSON) and this package renders it into
 * a real file on disk: DOCX, PDF, XLSX, PPTX, Markdown, HTML or CSV.
 *
 * ```ts
 * import { writeDocument, detectKind, slugify } from '@celeste/documents';
 *
 * const artifact = await writeDocument(
 *   { title: 'Report', blocks: [{ type: 'paragraph', text: 'Hello' }] },
 *   '/tmp/report.pdf',
 * );
 * ```
 */

export type {
  DeckSpec,
  DocBlock,
  DocBlockType,
  DocumentKind,
  DocumentSpec,
  DocumentTheme,
  ImageBlock,
  KeyValueBlock,
  SheetColumn,
  SheetSpec,
  SlideSpec,
  TableBlock,
  WorkbookSpec,
} from './types.js';

export { renderDocx } from './docx.js';
export { renderPdf } from './pdf.js';
export { renderXlsx, uniqueSheetName } from './xlsx.js';
export { renderPptx } from './pptx.js';
export { renderHtml, renderMarkdown, renderText } from './markdown.js';
export { renderCsv } from './csv.js';
export {
  detectKind,
  slugify,
  toDeckSpec,
  toDocumentSpec,
  toSheetSpec,
  toWorkbookSpec,
  writeDocument,
} from './write.js';

export {
  DEFAULT_ACCENT_COLOR,
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SIZE,
  DEFAULT_MARGIN,
  MONO_FONT_FAMILY,
  blockText,
  detectRasterType,
  escapeHtml,
  escapeMarkdown,
  fitImage,
  formatDocumentDate,
  headingLevel,
  hexToRgb,
  imageOf,
  keyValueOf,
  listDepth,
  loadImage,
  normaliseBlocks,
  normaliseHex,
  parseImageSize,
  pointsToPixels,
  resolveTheme,
  tableOf,
} from './blocks.js';

export type { LoadedImage, NormalisedTable, RasterType, ResolvedTheme } from './blocks.js';
