/**
 * DOCX renderer (Microsoft Word / OOXML).
 *
 * Produces a real `.docx` package: a title page header, styled headings,
 * lists, tables, quotes, code blocks, key/value lists and embedded images,
 * with theme-driven headers, footers and page numbers.
 */

import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import type { FileChild, ISectionOptions } from 'docx';

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
  pointsToPixels,
  resolveTheme,
  tableOf,
} from './blocks.js';
import type { ResolvedTheme } from './blocks.js';
import type { DocBlock, DocumentSpec } from './types.js';

/* -------------------------------------------------------------------------- */
/* Page geometry                                                              */
/* -------------------------------------------------------------------------- */

/** A4 in twips (1/20th of a point). */
const A4_WIDTH_TWIPS = 11906;
const A4_HEIGHT_TWIPS = 16838;

/** Points → twips. */
const toTwips = (points: number): number => Math.round(points * 20);

/** Half-points, the unit `docx` uses for font sizes. */
const toHalfPoints = (points: number): number => Math.round(points * 2);

const HEADING_SIZES = [22, 17, 14, 12, 11, 10.5];

const INK = '111827';
const MUTED = '6B7280';
const RULE = 'D4D4D8';
const CODE_FILL = 'F4F4F5';

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/** Render a {@link DocumentSpec} into a `.docx` buffer. */
export async function renderDocx(spec: DocumentSpec): Promise<Buffer> {
  const theme = resolveTheme(spec?.theme);
  const children: FileChild[] = [];

  children.push(...titleBlock(spec, theme));
  children.push(...(await bodyBlocks(spec, theme)));

  const doc = new Document({
    title: spec?.title ?? '',
    subject: spec?.subtitle ?? '',
    creator: 'Celeste',
    lastModifiedBy: spec?.author ?? 'Celeste',
    description: spec?.subtitle ?? spec?.title ?? '',
    keywords: Object.values(spec?.metadata ?? {}).join(', ') || undefined,
    customProperties: Object.entries(spec?.metadata ?? {})
      .filter(([name]) => name.trim().length > 0)
      .map(([name, value]) => ({ name, value: String(value ?? '') })),
    styles: { default: defaultStyles(theme) },
    numbering: { config: [orderedNumbering()] },
    sections: [section(children, theme)],
  });

  return Packer.toBuffer(doc);
}

/* -------------------------------------------------------------------------- */
/* Styles & sections                                                          */
/* -------------------------------------------------------------------------- */

function defaultStyles(theme: ResolvedTheme) {
  const run = { font: theme.fontFamily, size: toHalfPoints(theme.fontSize), color: INK };
  return {
    document: {
      run,
      paragraph: { spacing: { after: 120, line: 276 } },
    },
    title: {
      run: { ...run, size: toHalfPoints(26), bold: true, color: theme.accentColor },
      paragraph: { spacing: { before: 240, after: 120 } },
    },
    heading1: {
      run: { ...run, size: toHalfPoints(HEADING_SIZES[0] ?? 22), bold: true, color: theme.accentColor },
      paragraph: { spacing: { before: 320, after: 140 }, keepNext: true },
    },
    heading2: {
      run: { ...run, size: toHalfPoints(HEADING_SIZES[1] ?? 17), bold: true, color: INK },
      paragraph: { spacing: { before: 280, after: 120 }, keepNext: true },
    },
    heading3: {
      run: { ...run, size: toHalfPoints(HEADING_SIZES[2] ?? 14), bold: true, color: INK },
      paragraph: { spacing: { before: 240, after: 100 }, keepNext: true },
    },
    heading4: { run: { ...run, size: toHalfPoints(HEADING_SIZES[3] ?? 12), bold: true } },
    heading5: { run: { ...run, size: toHalfPoints(HEADING_SIZES[4] ?? 11), bold: true } },
    heading6: { run: { ...run, size: toHalfPoints(HEADING_SIZES[5] ?? 10.5), bold: true } },
  };
}

function section(children: FileChild[], theme: ResolvedTheme): ISectionOptions {
  const margin = toTwips(theme.margin);
  const options: ISectionOptions = {
    properties: {
      page: {
        size: { width: A4_WIDTH_TWIPS, height: A4_HEIGHT_TWIPS },
        margin: {
          top: margin,
          right: margin,
          bottom: margin,
          left: margin,
          header: toTwips(Math.max(18, theme.margin / 3)),
          footer: toTwips(Math.max(18, theme.margin / 3)),
        },
      },
    },
    children,
  };

  const header = theme.headerText
    ? new Header({
        children: [
          new Paragraph({
            alignment: AlignmentType.RIGHT,
            border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE, space: 6 } },
            children: [
              new TextRun({
                text: theme.headerText,
                size: toHalfPoints(8.5),
                color: MUTED,
              }),
            ],
          }),
        ],
      })
    : undefined;

  const footerChildren: Paragraph[] = [];
  if (theme.footerText) {
    footerChildren.push(
      new Paragraph({
        children: [new TextRun({ text: theme.footerText, size: toHalfPoints(8.5), color: MUTED })],
      }),
    );
  }
  footerChildren.push(
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      children: [
        new TextRun({ text: 'Page ', size: toHalfPoints(8.5), color: MUTED }),
        new TextRun({ children: [PageNumber.CURRENT], size: toHalfPoints(8.5), color: MUTED }),
        new TextRun({ text: ' of ', size: toHalfPoints(8.5), color: MUTED }),
        new TextRun({ children: [PageNumber.TOTAL_PAGES], size: toHalfPoints(8.5), color: MUTED }),
      ],
    }),
  );

  const footer = new Footer({ children: footerChildren });

  if (header) {
    return { ...options, headers: { default: header }, footers: { default: footer } };
  }
  return { ...options, footers: { default: footer } };
}

/** The decimal numbering definition used by `numbered` blocks. */
function orderedNumbering() {
  return {
    reference: 'ordered',
    levels: Array.from({ length: 9 }, (_unused, level) => ({
      level,
      format: LevelFormat.DECIMAL,
      text:
        Array.from({ length: level + 1 }, (_l, index) => `%${index + 1}`).join('.') +
        (level === 0 ? '.' : ''),
      alignment: AlignmentType.START,
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* Title block                                                                */
/* -------------------------------------------------------------------------- */

function titleBlock(spec: DocumentSpec, theme: ResolvedTheme): FileChild[] {
  const out: FileChild[] = [];
  const title = spec?.title?.trim();
  if (title) {
    out.push(
      new Paragraph({
        heading: HeadingLevel.TITLE,
        children: [new TextRun({ text: title, bold: true, color: theme.accentColor })],
      }),
    );
  }
  const subtitle = spec?.subtitle?.trim();
  if (subtitle) {
    out.push(
      new Paragraph({
        spacing: { after: 160 },
        children: [
          new TextRun({
            text: subtitle,
            italics: true,
            size: toHalfPoints(theme.fontSize + 2),
            color: MUTED,
          }),
        ],
      }),
    );
  }
  const author = spec?.author?.trim();
  const date = formatDocumentDate(spec?.date);
  const byline: string[] = [];
  if (author) byline.push(author);
  if (date) byline.push(date);
  if (byline.length > 0) {
    out.push(
      new Paragraph({
        spacing: { after: 320 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE, space: 8 } },
        children: [new TextRun({ text: byline.join('  ·  '), size: toHalfPoints(9), color: MUTED })],
      }),
    );
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Blocks                                                                     */
/* -------------------------------------------------------------------------- */

async function bodyBlocks(spec: DocumentSpec, theme: ResolvedTheme): Promise<FileChild[]> {
  const out: FileChild[] = [];
  for (const block of normaliseBlocks(spec)) {
    out.push(...(await renderBlock(block, theme)));
  }
  return out;
}

async function renderBlock(block: DocBlock, theme: ResolvedTheme): Promise<FileChild[]> {
  switch (block.type) {
    case 'heading': {
      const level = headingLevel(block);
      const heading = [
        HeadingLevel.HEADING_1,
        HeadingLevel.HEADING_2,
        HeadingLevel.HEADING_3,
        HeadingLevel.HEADING_4,
        HeadingLevel.HEADING_5,
        HeadingLevel.HEADING_6,
      ][level - 1] as (typeof HeadingLevel)[keyof typeof HeadingLevel];
      return [
        new Paragraph({
          heading,
          children: [
            new TextRun({
              text: blockText(block),
              bold: block.bold ?? true,
              italics: block.italic ?? false,
            }),
          ],
        }),
      ];
    }
    case 'paragraph':
      return [
        new Paragraph({
          children: [
            new TextRun({
              text: blockText(block),
              bold: block.bold ?? false,
              italics: block.italic ?? false,
            }),
          ],
        }),
      ];
    case 'bullet':
      return [
        new Paragraph({
          bullet: { level: listDepth(block) },
          children: [
            new TextRun({
              text: blockText(block),
              bold: block.bold ?? false,
              italics: block.italic ?? false,
            }),
          ],
        }),
      ];
    case 'numbered':
      return [
        new Paragraph({
          numbering: { reference: 'ordered', level: listDepth(block) },
          children: [
            new TextRun({
              text: blockText(block),
              bold: block.bold ?? false,
              italics: block.italic ?? false,
            }),
          ],
        }),
      ];
    case 'code':
      return codeBlock(block, theme);
    case 'table':
      return tableBlock(block, theme);
    case 'quote':
      return quoteBlock(block, theme);
    case 'divider':
      return [
        new Paragraph({
          spacing: { before: 160, after: 160 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE, space: 1 } },
          children: [],
        }),
      ];
    case 'pagebreak':
      return [new Paragraph({ pageBreakBefore: true, children: [] })];
    case 'image':
      return imageBlock(block, theme);
    case 'keyvalue':
      return keyValueBlock(block, theme);
    default:
      return [];
  }
}

function codeBlock(block: DocBlock, theme: ResolvedTheme): FileChild[] {
  const text = blockText(block);
  const lines = text.length > 0 ? text.split('\n') : [''];
  const out: FileChild[] = [];
  lines.forEach((line, index) => {
    out.push(
      new Paragraph({
        spacing: { before: index === 0 ? 120 : 0, after: index === lines.length - 1 ? 120 : 0, line: 240 },
        shading: { type: ShadingType.CLEAR, color: 'auto', fill: CODE_FILL },
        border: {
          left: { style: BorderStyle.SINGLE, size: 12, color: theme.accentColor, space: 8 },
          top: index === 0 ? { style: BorderStyle.SINGLE, size: 4, color: RULE, space: 4 } : undefined,
          bottom:
            index === lines.length - 1
              ? { style: BorderStyle.SINGLE, size: 4, color: RULE, space: 4 }
              : undefined,
        },
        children: [
          new TextRun({
            text: line.length > 0 ? line : ' ',
            font: MONO_FONT_FAMILY,
            size: toHalfPoints(9.5),
            color: INK,
          }),
        ],
      }),
    );
  });
  return out;
}

function tableBlock(block: DocBlock, theme: ResolvedTheme): FileChild[] {
  const table = tableOf(block);
  if (!table) return [];

  const columnCount = Math.max(
    table.headers.length,
    table.rows.reduce((max, row) => Math.max(max, row.length), 0),
  );
  if (columnCount === 0) return [];

  const contentWidth = A4_WIDTH_TWIPS - toTwips(theme.margin) * 2;
  const widths = columnWidths(table.widths, columnCount, contentWidth);

  const headerRow = new TableRow({
    tableHeader: true,
    cantSplit: true,
    children: range(columnCount).map((index) => {
      const label = table.headers[index] ?? '';
      return new TableCell({
        width: { size: widths[index] ?? 0, type: WidthType.DXA },
        shading: { type: ShadingType.CLEAR, color: 'auto', fill: tint(theme.accentColor) },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [
          new Paragraph({
            children: [
              new TextRun({
                text: label,
                bold: true,
                size: toHalfPoints(theme.fontSize - 0.5),
                color: INK,
              }),
            ],
          }),
        ],
      });
    }),
  });

  const bodyRows = table.rows.map(
    (row) =>
      new TableRow({
        cantSplit: true,
        children: range(columnCount).map((index) => {
          const value = row[index] ?? '';
          return new TableCell({
            width: { size: widths[index] ?? 0, type: WidthType.DXA },
            margins: { top: 60, bottom: 60, left: 120, right: 120 },
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: value,
                    size: toHalfPoints(theme.fontSize),
                    color: INK,
                  }),
                ],
              }),
            ],
          });
        }),
      }),
  );

  const out: FileChild[] = [];
  if (table.caption) {
    out.push(
      new Paragraph({
        spacing: { before: 160, after: 80 },
        children: [
          new TextRun({
            text: table.caption,
            bold: true,
            size: toHalfPoints(theme.fontSize),
            color: theme.accentColor,
          }),
        ],
      }),
    );
  }
  out.push(
    new Table({
      width: { size: contentWidth, type: WidthType.DXA },
      columnWidths: widths,
      borders: {
        top: { style: BorderStyle.SINGLE, size: 4, color: RULE },
        bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE },
        left: { style: BorderStyle.SINGLE, size: 4, color: RULE },
        right: { style: BorderStyle.SINGLE, size: 4, color: RULE },
        insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: RULE },
        insideVertical: { style: BorderStyle.SINGLE, size: 2, color: RULE },
      },
      rows: [headerRow, ...bodyRows],
    }),
  );
  out.push(new Paragraph({ spacing: { after: 120 }, children: [] }));
  return out;
}

function quoteBlock(block: DocBlock, theme: ResolvedTheme): FileChild[] {
  const out: FileChild[] = [
    new Paragraph({
      indent: { left: 360, right: 240 },
      spacing: { before: 160, after: 40 },
      border: { left: { style: BorderStyle.SINGLE, size: 18, color: theme.accentColor, space: 10 } },
      children: [
        new TextRun({
          text: blockText(block),
          italics: block.italic ?? true,
          size: toHalfPoints(theme.fontSize + 0.5),
          color: INK,
        }),
      ],
    }),
  ];
  const attribution = block.attribution?.trim();
  if (attribution) {
    out.push(
      new Paragraph({
        indent: { left: 360 },
        spacing: { after: 160 },
        children: [
          new TextRun({
            text: `— ${attribution}`,
            italics: true,
            size: toHalfPoints(theme.fontSize - 1),
            color: MUTED,
          }),
        ],
      }),
    );
  }
  return out;
}

async function imageBlock(block: DocBlock, theme: ResolvedTheme): Promise<FileChild[]> {
  const image = imageOf(block);
  if (!image) return [];
  const loaded = await loadImage(image.src);
  if (!loaded) return [];

  const maxWidth = Math.min(500, A4_WIDTH_TWIPS / 20 - theme.margin * 2);
  const maxHeight = 400;
  const fitted = fitImage(
    loaded.width,
    loaded.height,
    maxWidth,
    maxHeight,
    image.width,
    image.height,
  );

  const out: FileChild[] = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 160, after: 60 },
      children: [
        new ImageRun({
          type: loaded.type,
          data: loaded.data,
          transformation: {
            width: pointsToPixels(fitted.width),
            height: pointsToPixels(fitted.height),
          },
          altText: {
            title: image.alt ?? image.caption ?? 'image',
            description: image.alt ?? image.caption ?? '',
            name: image.alt ?? image.caption ?? 'image',
          },
        }),
      ],
    }),
  ];

  const caption = image.caption?.trim();
  if (caption) {
    out.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 160 },
        children: [
          new TextRun({
            text: caption,
            italics: true,
            size: toHalfPoints(theme.fontSize - 1),
            color: MUTED,
          }),
        ],
      }),
    );
  }
  return out;
}

function keyValueBlock(block: DocBlock, theme: ResolvedTheme): FileChild[] {
  const kv = keyValueOf(block);
  if (!kv || kv.entries.length === 0) return [];

  const contentWidth = A4_WIDTH_TWIPS - toTwips(theme.margin) * 2;
  const keyWidth = Math.round(contentWidth * 0.32);
  const valueWidth = contentWidth - keyWidth;

  const rows = kv.entries.map(
    (entry) =>
      new TableRow({
        cantSplit: true,
        children: [
          new TableCell({
            width: { size: keyWidth, type: WidthType.DXA },
            margins: { top: 40, bottom: 40, left: 0, right: 120 },
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: entry.key,
                    bold: true,
                    size: toHalfPoints(theme.fontSize),
                    color: INK,
                  }),
                ],
              }),
            ],
          }),
          new TableCell({
            width: { size: valueWidth, type: WidthType.DXA },
            margins: { top: 40, bottom: 40, left: 0, right: 0 },
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: entry.value,
                    size: toHalfPoints(theme.fontSize),
                    color: INK,
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
  );

  return [
    new Table({
      width: { size: contentWidth, type: WidthType.DXA },
      columnWidths: [keyWidth, valueWidth],
      borders: {
        top: { style: BorderStyle.NONE, size: 0, color: 'auto' },
        bottom: { style: BorderStyle.NONE, size: 0, color: 'auto' },
        left: { style: BorderStyle.NONE, size: 0, color: 'auto' },
        right: { style: BorderStyle.NONE, size: 0, color: 'auto' },
        insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'auto' },
        insideVertical: { style: BorderStyle.NONE, size: 0, color: 'auto' },
      },
      rows,
    }),
    new Paragraph({ spacing: { after: 120 }, children: [] }),
  ];
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

/** `[0, 1, ... count)` */
function range(count: number): number[] {
  return Array.from({ length: Math.max(0, count) }, (_unused, index) => index);
}

/** Turn relative weights into absolute twip widths. */
function columnWidths(
  weights: number[] | undefined,
  columnCount: number,
  totalWidth: number,
): number[] {
  if (weights && weights.length > 0) {
    const used = range(columnCount).map((index) => {
      const value = weights[index];
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1;
    });
    const sum = used.reduce((a, b) => a + b, 0);
    return used.map((value) => Math.max(1, Math.round((value / sum) * totalWidth)));
  }
  const each = Math.max(1, Math.floor(totalWidth / columnCount));
  const widths = range(columnCount).map(() => each);
  const last = widths[widths.length - 1];
  if (last !== undefined) widths[widths.length - 1] = totalWidth - each * (columnCount - 1);
  return widths;
}

/** A very light tint of the accent colour, used for table headers. */
function tint(hex: string): string {
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
