/**
 * Structured document specifications.
 *
 * The Celeste agent never touches a binary format directly: it emits one of
 * these plain JSON specs and the renderers in this package turn them into a
 * real file on disk (DOCX, PDF, XLSX, PPTX, Markdown, HTML, CSV).
 */

/** Every block kind a {@link DocBlock} can take. */
export type DocBlockType =
  | 'heading'
  | 'paragraph'
  | 'bullet'
  | 'numbered'
  | 'code'
  | 'table'
  | 'quote'
  | 'divider'
  | 'image'
  | 'pagebreak'
  | 'keyvalue';

/** A table block. */
export interface TableBlock {
  type: 'table';
  headers: string[];
  rows: (string | number | boolean | null)[][];
  caption?: string;
  /** Column widths as relative weights. */
  widths?: number[];
}

/** A key/value block, rendered as a two column definition list. */
export interface KeyValueBlock {
  type: 'keyvalue';
  entries: { key: string; value: string }[];
}

/** An image block. */
export interface ImageBlock {
  type: 'image';
  /** Absolute path to the image on disk, or a data: URI. */
  src: string;
  alt?: string;
  caption?: string;
  width?: number; // in points
  height?: number; // in points
}

/** A single block of document content. */
export interface DocBlock {
  type: DocBlockType;
  /** For heading/paragraph/bullet/numbered/quote/code. */
  text?: string;
  /** For heading: 1-6. For code: language label. */
  level?: number;
  language?: string;
  /** Inline bold/italic/code markers are NOT parsed — plain text only. */
  bold?: boolean;
  italic?: boolean;
  /** Bullet/numbered list nesting depth, 0-based. */
  depth?: number;
  table?: TableBlock;
  keyvalue?: KeyValueBlock;
  image?: ImageBlock;
  /** For 'quote': attribution. */
  attribution?: string;
}

/** Visual styling knobs shared by the document renderers. */
export interface DocumentTheme {
  accentColor?: string; // hex without '#', e.g. '4F46E5'
  fontFamily?: string; // default 'Helvetica'
  fontSize?: number; // default 11
  margin?: number; // points, default 54
  /** Header/footer text. */
  headerText?: string;
  footerText?: string;
}

/** A prose document (DOCX / PDF / Markdown / HTML). */
export interface DocumentSpec {
  title: string;
  subtitle?: string;
  author?: string;
  /** ISO date string; defaults to now. */
  date?: string;
  blocks: DocBlock[];
  metadata?: Record<string, string>;
  theme?: DocumentTheme;
}

/** A single spreadsheet column. */
export interface SheetColumn {
  header: string;
  key: string;
  width?: number;
  type?: 'string' | 'number' | 'boolean' | 'date' | 'url';
}

/** A single worksheet. */
export interface SheetSpec {
  name: string;
  title?: string;
  columns: SheetColumn[];
  rows: Record<string, unknown>[];
  /** Freeze the header row. Default true. */
  freezeHeader?: boolean;
  /** Autofilter on the header row. Default true. */
  autoFilter?: boolean;
}

/** A spreadsheet (XLSX / CSV). */
export interface WorkbookSpec {
  title?: string;
  author?: string;
  sheets: SheetSpec[];
  /** Optional accent colour, used for header fills. */
  theme?: DocumentTheme;
}

/** A single slide. */
export interface SlideSpec {
  title: string;
  bullets?: string[];
  notes?: string;
  imagePath?: string;
  layout?: 'title' | 'title-content' | 'section' | 'content';
  /** Two-column layout with a second bullet group. */
  bulletsRight?: string[];
}

/** A presentation (PPTX). */
export interface DeckSpec {
  title: string;
  subtitle?: string;
  author?: string;
  slides: SlideSpec[];
  /** Optional accent colour and fonts. */
  theme?: DocumentTheme;
}

/** Every output format this package can produce. */
export type DocumentKind = 'docx' | 'pdf' | 'xlsx' | 'pptx' | 'md' | 'html' | 'csv' | 'txt';
