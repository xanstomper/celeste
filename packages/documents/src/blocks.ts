/**
 * Shared helpers used by every renderer.
 *
 * The renderers each want slightly different things (Word wants half-points,
 * PDF wants points, HTML wants CSS), so this module keeps the *normalisation*
 * in one place: resolving the theme, sanitising blocks, and loading images.
 */

import { readFile } from 'node:fs/promises';

import type {
  DocBlock,
  DocumentSpec,
  DocumentTheme,
  ImageBlock,
  KeyValueBlock,
} from './types.js';

/* -------------------------------------------------------------------------- */
/* Defaults                                                                   */
/* -------------------------------------------------------------------------- */

export const DEFAULT_ACCENT_COLOR = '4F46E5';
export const DEFAULT_FONT_FAMILY = 'Helvetica';
export const DEFAULT_FONT_SIZE = 11;
export const DEFAULT_MARGIN = 54;
export const MONO_FONT_FAMILY = 'Courier New';

/** A theme with every default filled in. */
export interface ResolvedTheme {
  accentColor: string;
  fontFamily: string;
  fontSize: number;
  margin: number;
  headerText?: string;
  footerText?: string;
}

/**
 * Fill in the theme defaults. `accentColor` is normalised to six uppercase
 * hex digits without a leading `#` so it can be handed to any of the
 * underlying libraries unchanged.
 */
export function resolveTheme(theme?: DocumentTheme): ResolvedTheme {
  const resolved: ResolvedTheme = {
    accentColor: normaliseHex(theme?.accentColor) ?? DEFAULT_ACCENT_COLOR,
    fontFamily: theme?.fontFamily?.trim() || DEFAULT_FONT_FAMILY,
    fontSize: clampNumber(theme?.fontSize, 6, 96) ?? DEFAULT_FONT_SIZE,
    margin: clampNumber(theme?.margin, 0, 288) ?? DEFAULT_MARGIN,
  };
  if (theme?.headerText) resolved.headerText = theme.headerText;
  if (theme?.footerText) resolved.footerText = theme.footerText;
  return resolved;
}

/**
 * Normalise a colour to `#RRGGBB` / `RRGGBB` uppercase hex.
 * Returns `null` when the value cannot be understood.
 */
export function normaliseHex(color: string | undefined): string | null {
  if (!color) return null;
  let value = color.trim().replace(/^#/, '');
  if (value.length === 3) {
    value = value
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return null;
  return value.toUpperCase();
}

/** Clamp a number into a range, returning `undefined` for junk input. */
export function clampNumber(
  value: number | undefined,
  min: number,
  max: number,
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, value));
}

/** Convert a CSS-ish `#RRGGBB` colour into `r, g, b` for use in `rgba()`. */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const value = normaliseHex(hex) ?? DEFAULT_ACCENT_COLOR;
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

/* -------------------------------------------------------------------------- */
/* Block normalisation                                                        */
/* -------------------------------------------------------------------------- */

/** The set of block types the renderers understand. */
const KNOWN_BLOCK_TYPES = new Set<string>([
  'heading',
  'paragraph',
  'bullet',
  'numbered',
  'code',
  'table',
  'quote',
  'divider',
  'image',
  'pagebreak',
  'keyvalue',
]);

/**
 * Drop blocks that are not renderable and make sure the array is safe to
 * iterate. Always returns an array, even for `undefined` input.
 */
export function normaliseBlocks(spec: Pick<DocumentSpec, 'blocks'>): DocBlock[] {
  const blocks = Array.isArray(spec?.blocks) ? spec.blocks : [];
  const out: DocBlock[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const type = (block as { type?: unknown }).type;
    if (typeof type !== 'string' || !KNOWN_BLOCK_TYPES.has(type)) continue;
    out.push(block);
  }
  return out;
}

/** The plain text of a block, never `undefined`. */
export function blockText(block: DocBlock): string {
  return typeof block.text === 'string' ? block.text : '';
}

/** Heading level clamped to 1..6 (defaults to 1). */
export function headingLevel(block: DocBlock): number {
  const level = typeof block.level === 'number' ? Math.round(block.level) : 1;
  if (!Number.isFinite(level)) return 1;
  return Math.min(6, Math.max(1, level));
}

/** List nesting depth clamped to 0..8 (defaults to 0). */
export function listDepth(block: DocBlock): number {
  const depth = typeof block.depth === 'number' ? Math.round(block.depth) : 0;
  if (!Number.isFinite(depth)) return 0;
  return Math.min(8, Math.max(0, depth));
}

/** A table block with every cell coerced to a string. */
export interface NormalisedTable {
  headers: string[];
  rows: string[][];
  caption?: string;
  widths?: number[];
}

/** The table payload of a block, or `null` when it is missing/unusable. */
export function tableOf(block: DocBlock): NormalisedTable | null {
  const table = block.table;
  if (!table || typeof table !== 'object') return null;
  const headers = Array.isArray(table.headers) ? table.headers.map(asText) : [];
  const rows = Array.isArray(table.rows)
    ? table.rows.map((row) => (Array.isArray(row) ? row.map(asText) : []))
    : [];
  const out: NormalisedTable = { headers, rows };
  if (typeof table.caption === 'string' && table.caption) out.caption = table.caption;
  if (Array.isArray(table.widths) && table.widths.length > 0) {
    out.widths = table.widths.map((w) => (typeof w === 'number' && Number.isFinite(w) ? w : 1));
  }
  return out;
}

/** The key/value payload of a block, or `null` when it is missing/unusable. */
export function keyValueOf(block: DocBlock): KeyValueBlock | null {
  const kv = block.keyvalue;
  if (!kv || typeof kv !== 'object') return null;
  const entries = Array.isArray(kv.entries)
    ? kv.entries
        .filter((e) => e && typeof e === 'object')
        .map((e) => ({ key: asText((e as { key?: unknown }).key), value: asText((e as { value?: unknown }).value) }))
    : [];
  return { type: 'keyvalue', entries };
}

/** The image payload of a block, or `null` when it is missing/unusable. */
export function imageOf(block: DocBlock): ImageBlock | null {
  const image = block.image;
  if (!image || typeof image !== 'object') return null;
  if (typeof image.src !== 'string' || image.src.length === 0) return null;
  return image;
}

/** Coerce any value into a display string. `null`/`undefined` become `''`. */
export function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return value.toISOString();
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

/* -------------------------------------------------------------------------- */
/* Dates                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Format the spec date for display. Invalid or missing dates fall back to
 * today's date; a supplied but unparseable string is shown verbatim.
 */
export function formatDocumentDate(iso: string | undefined): string {
  const fallback = new Date();
  if (!iso || typeof iso !== 'string') return formatDate(fallback);
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return formatDate(parsed);
}

/** `20 October 2026` */
function formatDate(date: Date): string {
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  const month = months[date.getUTCMonth()] ?? '';
  return `${date.getUTCDate()} ${month} ${date.getUTCFullYear()}`;
}

/* -------------------------------------------------------------------------- */
/* Text escaping                                                             */
/* -------------------------------------------------------------------------- */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape a string for inclusion in HTML text or an attribute. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/**
 * Escape the characters that would otherwise be Markdown syntax.
 * Line-leading list markers are escaped too, so a paragraph that starts with
 * `-` is not turned into a bullet. A marker only counts when it is followed
 * by whitespace, so `0.1.0` stays untouched.
 */
export function escapeMarkdown(value: string): string {
  return value
    .split('\n')
    .map((line) => {
      const escaped = line.replace(/([\\`*_{}[\]|<>#])/g, '\\$1');
      return escaped.replace(
        /^(\s*)(?:([-+>])(?=\s)|(\d+[.)])(?=\s))/,
        (_match, space: string, marker: string, digits: string) =>
          digits ? `${space}\\${digits}` : `${space}\\${marker}`,
      );
    })
    .join('\n');
}

/* -------------------------------------------------------------------------- */
/* Images                                                                     */
/* -------------------------------------------------------------------------- */

/** Raster formats the docx renderer can embed. */
export type RasterType = 'png' | 'jpg' | 'gif' | 'bmp';

/** A decoded image ready to be embedded. */
export interface LoadedImage {
  /** The raw bytes of the image. */
  data: Buffer;
  /** The detected format. */
  type: RasterType;
  /** Intrinsic width in pixels, when it could be determined. */
  width?: number;
  /** Intrinsic height in pixels, when it could be determined. */
  height?: number;
}

/**
 * Load an image from a `data:` URI or from disk. Returns `null` when the
 * source cannot be read or is not a supported raster format.
 */
export async function loadImage(src: string): Promise<LoadedImage | null> {
  if (!src) return null;
  let data: Buffer;
  try {
    if (src.startsWith('data:')) {
      data = decodeDataUri(src);
    } else {
      data = await readFile(src);
    }
  } catch {
    return null;
  }
  if (data.length === 0) return null;
  const type = detectRasterType(data);
  if (!type) return null;
  const size = parseImageSize(data, type);
  const image: LoadedImage = { data, type };
  if (size) {
    image.width = size.width;
    image.height = size.height;
  }
  return image;
}

/** Decode a `data:` URI into raw bytes. */
export function decodeDataUri(uri: string): Buffer {
  const comma = uri.indexOf(',');
  if (comma < 0) throw new Error('Malformed data URI');
  const meta = uri.slice(5, comma);
  const payload = uri.slice(comma + 1);
  if (/;base64/i.test(meta)) {
    return Buffer.from(payload, 'base64');
  }
  return Buffer.from(decodeURIComponent(payload), 'utf8');
}

/** Sniff the raster format from the file magic. */
export function detectRasterType(data: Buffer): RasterType | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'jpg';
  }
  if (data.length >= 6) {
    const header = data.subarray(0, 6).toString('latin1');
    if (header === 'GIF87a' || header === 'GIF89a') return 'gif';
  }
  if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d) return 'bmp';
  return null;
}

/**
 * Read the intrinsic pixel dimensions of an image by parsing its header.
 * Returns `null` when the format is unknown or the header is malformed.
 */
export function parseImageSize(
  data: Buffer,
  type: RasterType = detectRasterType(data) ?? 'png',
): { width: number; height: number } | null {
  try {
    switch (type) {
      case 'png':
        // IHDR is always the first chunk: 8 byte signature, 4 byte length,
        // 4 byte type, then width and height as big endian uint32.
        if (data.length >= 24 && data.subarray(12, 16).toString('latin1') === 'IHDR') {
          return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
        }
        return null;
      case 'jpg':
        return parseJpegSize(data);
      case 'gif':
        if (data.length >= 10) {
          return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
        }
        return null;
      case 'bmp':
        if (data.length >= 26) {
          return { width: Math.abs(data.readInt32LE(18)), height: Math.abs(data.readInt32LE(22)) };
        }
        return null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Walk the JPEG segment list to find the SOF frame header. */
function parseJpegSize(data: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = data[offset + 1] ?? 0;
    // Standalone markers (no length field).
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = data.readUInt16BE(offset + 2);
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
    }
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

/** CSS pixels → points (96 DPI). */
const PX_TO_PT = 72 / 96;

/**
 * Fit an image inside a box, preserving the aspect ratio.
 *
 * Intrinsic dimensions are in **pixels** (as read from the file header) and
 * the box is in **points**; the result is in **points**. Images are never
 * scaled up beyond their natural size.
 */
export function fitImage(
  intrinsicWidth: number | undefined,
  intrinsicHeight: number | undefined,
  maxWidth: number,
  maxHeight: number,
  explicitWidth?: number,
  explicitHeight?: number,
): { width: number; height: number } {
  const naturalWidth = intrinsicWidth ? intrinsicWidth * PX_TO_PT : undefined;
  const naturalHeight = intrinsicHeight ? intrinsicHeight * PX_TO_PT : undefined;

  if (explicitWidth && explicitHeight) {
    return { width: explicitWidth, height: explicitHeight };
  }
  if (explicitWidth) {
    const ratio = naturalWidth && naturalHeight ? naturalHeight / naturalWidth : 0.75;
    return { width: explicitWidth, height: Math.min(maxHeight, explicitWidth * ratio) };
  }
  if (explicitHeight) {
    const ratio = naturalWidth && naturalHeight ? naturalWidth / naturalHeight : 1.3333;
    return { width: Math.min(maxWidth, explicitHeight * ratio), height: explicitHeight };
  }
  if (!naturalWidth || !naturalHeight) {
    return { width: Math.min(maxWidth, maxHeight), height: Math.min(maxHeight, maxWidth) };
  }
  const scale = Math.min(maxWidth / naturalWidth, maxHeight / naturalHeight, 1);
  return {
    width: Math.max(1, naturalWidth * scale),
    height: Math.max(1, naturalHeight * scale),
  };
}

/** Convert points to the pixel values the `docx` library expects (96 DPI). */
export function pointsToPixels(points: number): number {
  return Math.round((points * 96) / 72);
}
