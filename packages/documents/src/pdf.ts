/**
 * PDF renderer (pdfkit).
 *
 * pdfkit has no document model, so this module implements a small layout
 * engine on top of it: it tracks the cursor, paginates, repeats table
 * headers and finally writes headers/footers across the buffered pages.
 */

import PDFDocument from 'pdfkit';

import {
  MONO_FONT_FAMILY,
  blockText,
  fitImage,
  formatDocumentDate,
  headingLevel,
  imageOf,
  keyValueOf,
  listDepth,
  loadImage,
  normaliseBlocks,
  resolveTheme,
  tableOf,
} from './blocks.js';
import type { ResolvedTheme } from './blocks.js';
import type { DocBlock, DocumentSpec } from './types.js';

/* -------------------------------------------------------------------------- */
/* Colours & fonts                                                            */
/* -------------------------------------------------------------------------- */

const INK = '#111827';
const MUTED = '#6B7280';
const RULE = '#D4D4D8';
const CODE_BG = '#F4F4F5';

const HEADING_SIZES = [22, 17, 14, 12, 11, 10.5];

/** The fonts pdfkit can use without embedding a font file. */
const STANDARD_FONTS = new Set([
  'Helvetica',
  'Helvetica-Bold',
  'Helvetica-Oblique',
  'Helvetica-BoldOblique',
  'Courier',
  'Courier-Bold',
  'Courier-Oblique',
  'Courier-BoldOblique',
  'Times-Roman',
  'Times-Bold',
  'Times-Italic',
  'Times-BoldItalic',
  'Symbol',
  'ZapfDingbats',
]);

/** Map common font names onto the PDF standard fonts. */
const FONT_ALIASES: Record<string, string> = {
  helvetica: 'Helvetica',
  arial: 'Helvetica',
  'helvetica neue': 'Helvetica',
  courier: 'Courier',
  'courier new': 'Courier',
  monospace: 'Courier',
  'courier mono': 'Courier',
  times: 'Times-Roman',
  'times new roman': 'Times-Roman',
  'times roman': 'Times-Roman',
  serif: 'Times-Roman',
  georgia: 'Times-Roman',
  symbol: 'Symbol',
  'zapfdingbats': 'ZapfDingbats',
};

/**
 * Resolve a theme font family to a font pdfkit definitely has. Unknown
 * families fall back to Helvetica rather than blowing up mid-document.
 */
function resolveFont(family: string, bold: boolean, italic: boolean): string {
  const key = family.trim().toLowerCase();
  const base = FONT_ALIASES[key] ?? (STANDARD_FONTS.has(family) ? family : 'Helvetica');
  if (base === 'Courier') {
    if (bold && italic) return 'Courier-BoldOblique';
    if (bold) return 'Courier-Bold';
    if (italic) return 'Courier-Oblique';
    return 'Courier';
  }
  if (base === 'Times-Roman') {
    if (bold && italic) return 'Times-BoldItalic';
    if (bold) return 'Times-Bold';
    if (italic) return 'Times-Italic';
    return 'Times-Roman';
  }
  if (base === 'Helvetica') {
    if (bold && italic) return 'Helvetica-BoldOblique';
    if (bold) return 'Helvetica-Bold';
    if (italic) return 'Helvetica-Oblique';
    return 'Helvetica';
  }
  return base;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/** Render a {@link DocumentSpec} into a PDF buffer. */
export async function renderPdf(spec: DocumentSpec): Promise<Buffer> {
  const theme = resolveTheme(spec?.theme);
  const doc = new PDFDocument({
    size: 'A4',
    margin: theme.margin,
    bufferPages: true,
    info: {
      Title: spec?.title ?? '',
      Author: spec?.author ?? '',
      Subject: spec?.subtitle ?? '',
      Creator: 'Celeste',
      Producer: 'Celeste document pipeline',
      Keywords: Object.values(spec?.metadata ?? {}).join(', '),
    },
  });

  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', (err: Error) => reject(err));
  });

  const ctx = new Layout(doc, theme);
  ctx.start();
  ctx.titlePage(spec);
  for (const block of normaliseBlocks(spec)) {
    await ctx.block(block);
  }
  ctx.finish();

  return done;
}

/* -------------------------------------------------------------------------- */
/* Layout engine                                                              */
/* -------------------------------------------------------------------------- */

class Layout {
  private readonly doc: PDFKit.PDFDocument;
  private readonly theme: ResolvedTheme;
  private y = 0;
  /** Number of the page currently being written. */
  private page = 1;
  /** Counters for numbered lists, per nesting depth. */
  private readonly counters: number[] = [];
  /** True while a numbered list is open, so counters reset on a new list. */
  private lastWasNumbered = false;

  constructor(doc: PDFKit.PDFDocument, theme: ResolvedTheme) {
    this.doc = doc;
    this.theme = theme;
  }

  /* ---------------------------------------------------------------------- */
  /* Geometry                                                              */
  /* ---------------------------------------------------------------------- */

  private get left(): number {
    return this.theme.margin;
  }

  private get contentWidth(): number {
    return this.doc.page.width - this.theme.margin * 2;
  }

  /** The lowest y a block may start at before a page break is needed. */
  private get bottomLimit(): number {
    return this.doc.page.height - this.theme.margin - 28;
  }

  private get headerReserve(): number {
    return this.theme.headerText ? 22 : 0;
  }

  /* ---------------------------------------------------------------------- */
  /* Page management                                                       */
  /* ---------------------------------------------------------------------- */

  /** Begin the first page. */
  start(): void {
    this.y = this.theme.margin + this.headerReserve;
    this.drawHeader();
  }

  /** Start a new page and redraw the header. */
  newPage(): void {
    this.doc.addPage();
    this.page += 1;
    this.y = this.theme.margin + this.headerReserve;
    this.drawHeader();
  }

  /** Make sure `height` points of vertical space are available. */
  private ensure(height: number): void {
    if (this.y + height > this.bottomLimit) {
      this.newPage();
    }
  }

  private drawHeader(): void {
    const text = this.theme.headerText;
    if (!text) return;
    const y = Math.max(8, this.theme.margin - 6);
    this.doc
      .font(resolveFont(this.theme.fontFamily, false, false))
      .fontSize(8.5)
      .fillColor(MUTED)
      .text(text, this.left, y, { width: this.contentWidth, align: 'right', lineBreak: false });
    this.doc
      .moveTo(this.left, y + 11)
      .lineTo(this.left + this.contentWidth, y + 11)
      .lineWidth(0.5)
      .strokeColor(RULE)
      .stroke();
  }

  /* ---------------------------------------------------------------------- */
  /* Text helpers                                                          */
  /* ---------------------------------------------------------------------- */

  /** Draw a block of flowing text and advance the cursor. */
  private flow(
    text: string,
    options: {
      font?: string;
      size?: number;
      color?: string;
      indent?: number;
      width?: number;
      align?: 'left' | 'center' | 'right' | 'justify';
      lineGap?: number;
      spaceBefore?: number;
      spaceAfter?: number;
    } = {},
  ): void {
    const content = text ?? '';
    if (content.length === 0) {
      this.y += options.spaceAfter ?? 0;
      return;
    }
    const size = options.size ?? this.theme.fontSize;
    const font = options.font ?? resolveFont(this.theme.fontFamily, false, false);
    const indent = options.indent ?? 0;
    const width = (options.width ?? this.contentWidth) - indent;

    this.doc.font(font).fontSize(size);
    const height = this.doc.heightOfString(content, {
      width,
      lineGap: options.lineGap ?? 2,
    });

    this.y += options.spaceBefore ?? 0;
    this.ensure(height);
    this.doc
      .font(font)
      .fontSize(size)
      .fillColor(options.color ?? INK)
      .text(content, this.left + indent, this.y, {
        width,
        align: options.align ?? 'left',
        lineGap: options.lineGap ?? 2,
      });
    this.y = this.doc.y;
    this.y += options.spaceAfter ?? 0;
  }

  /* ---------------------------------------------------------------------- */
  /* Title page                                                            */
  /* ---------------------------------------------------------------------- */

  titlePage(spec: DocumentSpec): void {
    const title = spec?.title?.trim();
    if (title) {
      this.flow(title, {
        font: resolveFont(this.theme.fontFamily, true, false),
        size: 26,
        color: `#${this.theme.accentColor}`,
        spaceAfter: 6,
      });
    }
    const subtitle = spec?.subtitle?.trim();
    if (subtitle) {
      this.flow(subtitle, {
        font: resolveFont(this.theme.fontFamily, false, true),
        size: this.theme.fontSize + 2,
        color: MUTED,
        spaceAfter: 10,
      });
    }
    const byline: string[] = [];
    if (spec?.author?.trim()) byline.push(spec.author.trim());
    const date = formatDocumentDate(spec?.date);
    if (date) byline.push(date);
    if (byline.length > 0) {
      this.flow(byline.join('  ·  '), { size: 9, color: MUTED, spaceAfter: 14 });
      this.doc
        .moveTo(this.left, this.y)
        .lineTo(this.left + this.contentWidth, this.y)
        .lineWidth(0.5)
        .strokeColor(RULE)
        .stroke();
      this.y += 12;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Blocks                                                                */
  /* ---------------------------------------------------------------------- */

  async block(block: DocBlock): Promise<void> {
    switch (block.type) {
      case 'heading':
        return this.heading(block);
      case 'paragraph':
        this.flow(blockText(block), {
          font: resolveFont(this.theme.fontFamily, block.bold ?? false, block.italic ?? false),
          spaceAfter: 8,
        });
        return;
      case 'bullet':
        return this.bullet(block);
      case 'numbered':
        return this.numbered(block);
      case 'code':
        return this.code(block);
      case 'table':
        return this.table(block);
      case 'quote':
        return this.quote(block);
      case 'divider':
        return this.divider();
      case 'pagebreak':
        this.newPage();
        return;
      case 'image':
        return this.image(block);
      case 'keyvalue':
        return this.keyValue(block);
      default:
        return;
    }
  }

  private heading(block: DocBlock): void {
    const level = headingLevel(block);
    const size = HEADING_SIZES[level - 1] ?? this.theme.fontSize;
    this.flow(blockText(block), {
      font: resolveFont(this.theme.fontFamily, true, block.italic ?? false),
      size,
      color: level === 1 ? `#${this.theme.accentColor}` : INK,
      spaceBefore: level === 1 ? 14 : 10,
      spaceAfter: 6,
    });
  }

  private bullet(block: DocBlock): void {
    const depth = listDepth(block);
    const indent = 14 + depth * 16;
    this.lastWasNumbered = false;
    this.flow(`• ${blockText(block)}`, {
      indent,
      spaceAfter: 3,
    });
  }

  private numbered(block: DocBlock): void {
    const depth = listDepth(block);
    if (!this.lastWasNumbered) {
      this.counters.length = 0;
    }
    this.lastWasNumbered = true;
    while (this.counters.length <= depth) this.counters.push(0);
    const counter = this.counters[depth] ?? 0;
    this.counters[depth] = counter + 1;
    for (let index = depth + 1; index < this.counters.length; index += 1) {
      this.counters[index] = 0;
    }
    const indent = 14 + depth * 16;
    this.flow(`${counter + 1}. ${blockText(block)}`, { indent, spaceAfter: 3 });
  }

  private code(block: DocBlock): void {
    const text = blockText(block);
    const lines = text.length > 0 ? text.split('\n') : [''];
    const font = resolveFont(MONO_FONT_FAMILY, false, false);
    const size = 9.5;
    const padding = 8;

    this.doc.font(font).fontSize(size);
    const bodyHeight = lines.reduce(
      (total, line) => total + this.doc.heightOfString(line.length > 0 ? line : ' ', { width: this.contentWidth - padding * 2 }),
      0,
    );
    const boxHeight = bodyHeight + padding * 2;

    this.ensure(boxHeight);

    // Background panel.
    this.doc
      .save()
      .rect(this.left, this.y, this.contentWidth, boxHeight)
      .fillColor(CODE_BG)
      .fill()
      .restore();

    // Accent rule down the left edge.
    this.doc
      .moveTo(this.left, this.y)
      .lineTo(this.left, this.y + boxHeight)
      .lineWidth(2)
      .strokeColor(`#${this.theme.accentColor}`)
      .stroke();

    let cursor = this.y + padding;
    for (const line of lines) {
      this.doc
        .font(font)
        .fontSize(size)
        .fillColor(INK)
        .text(line.length > 0 ? line : ' ', this.left + padding, cursor, {
          width: this.contentWidth - padding * 2,
        });
      cursor = this.doc.y;
    }
    this.y = this.y + boxHeight + 10;
  }

  private quote(block: DocBlock): void {
    const indent = 24;
    const content = blockText(block);
    const font = resolveFont(this.theme.fontFamily, false, true);
    this.doc.font(font).fontSize(this.theme.fontSize + 0.5);
    const height = this.doc.heightOfString(content, { width: this.contentWidth - indent });

    this.ensure(height + 8);
    this.doc
      .moveTo(this.left, this.y)
      .lineTo(this.left, this.y + height + 4)
      .lineWidth(2)
      .strokeColor(`#${this.theme.accentColor}`)
      .stroke();

    this.doc
      .font(font)
      .fontSize(this.theme.fontSize + 0.5)
      .fillColor(INK)
      .text(content, this.left + indent, this.y, { width: this.contentWidth - indent });
    this.y = this.doc.y;

    const attribution = block.attribution?.trim();
    if (attribution) {
      this.flow(`— ${attribution}`, {
        indent,
        size: this.theme.fontSize - 1,
        color: MUTED,
        spaceAfter: 10,
      });
    } else {
      this.y += 10;
    }
  }

  private divider(): void {
    this.ensure(12);
    this.y += 6;
    this.doc
      .moveTo(this.left, this.y)
      .lineTo(this.left + this.contentWidth, this.y)
      .lineWidth(0.75)
      .strokeColor(RULE)
      .stroke();
    this.y += 12;
  }

  private keyValue(block: DocBlock): void {
    const kv = keyValueOf(block);
    if (!kv || kv.entries.length === 0) return;
    const keyWidth = this.contentWidth * 0.32;
    const valueWidth = this.contentWidth - keyWidth;
    const size = this.theme.fontSize;

    for (const entry of kv.entries) {
      this.doc.font(resolveFont(this.theme.fontFamily, false, false)).fontSize(size);
      const keyHeight = this.doc.heightOfString(entry.key, { width: keyWidth - 8 });
      const valueHeight = this.doc.heightOfString(entry.value, { width: valueWidth });
      const rowHeight = Math.max(keyHeight, valueHeight);

      this.ensure(rowHeight + 4);
      this.doc
        .font(resolveFont(this.theme.fontFamily, true, false))
        .fontSize(size)
        .fillColor(INK)
        .text(entry.key, this.left, this.y, { width: keyWidth - 8 });
      this.doc
        .font(resolveFont(this.theme.fontFamily, false, false))
        .fontSize(size)
        .fillColor(INK)
        .text(entry.value, this.left + keyWidth, this.y, { width: valueWidth });
      this.y += rowHeight + 4;
    }
    this.y += 8;
  }

  private table(block: DocBlock): void {
    const table = tableOf(block);
    if (!table) return;

    const columnCount = Math.max(
      table.headers.length,
      table.rows.reduce((max, row) => Math.max(max, row.length), 0),
    );
    if (columnCount === 0) return;

    const widths = this.columnWidths(table.widths, columnCount);
    const padding = 6;
    const size = this.theme.fontSize;
    const headerSize = size - 0.5;

    if (table.caption) {
      this.flow(table.caption, {
        font: resolveFont(this.theme.fontFamily, true, false),
        size,
        color: `#${this.theme.accentColor}`,
        spaceBefore: 6,
        spaceAfter: 4,
      });
    }

    const drawHeader = (): void => {
      const heights = widths.map((width, index) =>
        this.doc
          .font(resolveFont(this.theme.fontFamily, true, false))
          .fontSize(headerSize)
          .heightOfString(table.headers[index] ?? '', { width: width - padding * 2 }),
      );
      const rowHeight = Math.max(...heights, 12) + padding * 2;
      this.ensure(rowHeight);

      const top = this.y;
      this.doc
        .save()
        .rect(this.left, top, this.contentWidth, rowHeight)
        .fillColor(`#${tintOf(this.theme.accentColor)}`)
        .fill()
        .restore();

      let x = this.left;
      widths.forEach((width, index) => {
        this.doc
          .font(resolveFont(this.theme.fontFamily, true, false))
          .fontSize(headerSize)
          .fillColor(INK)
          .text(table.headers[index] ?? '', x + padding, top + padding, {
            width: width - padding * 2,
          });
        x += width;
      });
      this.y = top + rowHeight;
      this.hline(top);
      this.hline(this.y);
    };

    drawHeader();

    for (const row of table.rows) {
      const cells = widths.map((width, index) => {
        const value = row[index] ?? '';
        return this.doc
          .font(resolveFont(this.theme.fontFamily, false, false))
          .fontSize(size)
          .heightOfString(value, { width: width - padding * 2 });
      });
      const rowHeight = Math.max(...cells, 10) + padding * 2;

      if (this.y + rowHeight > this.bottomLimit) {
        this.newPage();
        drawHeader();
      }

      const top = this.y;
      let x = this.left;
      widths.forEach((width, index) => {
        this.doc
          .font(resolveFont(this.theme.fontFamily, false, false))
          .fontSize(size)
          .fillColor(INK)
          .text(row[index] ?? '', x + padding, top + padding, { width: width - padding * 2 });
        x += width;
      });
      this.y = top + rowHeight;
      this.hline(this.y);
      // Vertical separators.
      let vx = this.left;
      this.doc.lineWidth(0.25).strokeColor(RULE);
      for (const width of widths) {
        vx += width;
        this.doc.moveTo(vx, top).lineTo(vx, this.y).stroke();
      }
    }

    this.y += 12;
  }

  /** Relative weights → absolute point widths. */
  private columnWidths(weights: number[] | undefined, columnCount: number): number[] {
    if (weights && weights.length > 0) {
      const used = Array.from({ length: columnCount }, (_unused, index) => {
        const value = weights[index];
        return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1;
      });
      const sum = used.reduce((a, b) => a + b, 0);
      return used.map((value) => Math.max(24, (value / sum) * this.contentWidth));
    }
    return Array.from({ length: columnCount }, () => this.contentWidth / columnCount);
  }

  private hline(y: number): void {
    this.doc
      .moveTo(this.left, y)
      .lineTo(this.left + this.contentWidth, y)
      .lineWidth(0.5)
      .strokeColor(RULE)
      .stroke();
  }

  private async image(block: DocBlock): Promise<void> {
    const image = imageOf(block);
    if (!image) return;
    const loaded = await loadImage(image.src);
    if (!loaded) return;
    // pdfkit can only decode PNG and JPEG.
    if (loaded.type !== 'png' && loaded.type !== 'jpg') return;

    const maxWidth = Math.min(500, this.contentWidth);
    const maxHeight = 400;
    const fitted = fitImage(loaded.width, loaded.height, maxWidth, maxHeight, image.width, image.height);

    this.ensure(fitted.height + 12);
    const x = this.left + (this.contentWidth - fitted.width) / 2;
    this.doc.image(loaded.data, x, this.y, { fit: [fitted.width, fitted.height] });
    this.y += fitted.height + 8;

    const caption = image.caption?.trim();
    if (caption) {
      this.flow(caption, {
        font: resolveFont(this.theme.fontFamily, false, true),
        size: this.theme.fontSize - 1,
        color: MUTED,
        align: 'center',
        spaceAfter: 10,
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Finishing                                                             */
  /* ---------------------------------------------------------------------- */

  /** Write the footers across every buffered page and close the document. */
  finish(): void {
    const range = this.doc.bufferedPageRange();
    const total = range.count;

    for (let index = range.start; index < range.start + range.count; index += 1) {
      this.doc.switchToPage(index);
      const pageNumber = index - range.start + 1;
      const y = this.doc.page.height - this.theme.margin + 6;

      const footerText = this.theme.footerText;
      if (footerText) {
        this.doc
          .font(resolveFont(this.theme.fontFamily, false, false))
          .fontSize(8.5)
          .fillColor(MUTED)
          .text(footerText, this.left, y, { width: this.contentWidth, align: 'left', lineBreak: false });
      }

      this.doc
        .font(resolveFont(this.theme.fontFamily, false, false))
        .fontSize(8.5)
        .fillColor(MUTED)
        .text(`Page ${pageNumber} of ${total}`, this.left, y, {
          width: this.contentWidth,
          align: 'right',
          lineBreak: false,
        });
    }

    this.doc.flushPages();
    this.doc.end();
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** A very light tint of the accent colour, used for table headers. */
function tintOf(hex: string): string {
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16) || 0;
  const g = parseInt(value.slice(2, 4), 16) || 0;
  const b = parseInt(value.slice(4, 6), 16) || 0;
  const mix = (channel: number): number => Math.round(channel * 0.12 + 255 * 0.88);
  return [mix(r), mix(g), mix(b)]
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}
