/**
 * XLSX renderer (exceljs).
 *
 * One worksheet per {@link SheetSpec}, with a styled header row, frozen
 * panes, an autofilter, inferred column widths and per-column value types.
 */

import ExcelJS from 'exceljs';

import { asText, normaliseHex, resolveTheme } from './blocks.js';
import type { ResolvedTheme } from './blocks.js';
import type { SheetColumn, SheetSpec, WorkbookSpec } from './types.js';

/** Excel refuses sheet names longer than this. */
const MAX_SHEET_NAME = 31;
/** Excel refuses column widths above this. */
const MAX_COLUMN_WIDTH = 60;
/** Characters Excel does not allow in a sheet name. */
const INVALID_SHEET_NAME_CHARS = /[\\/*?:[\]]/g;

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/** Render a {@link WorkbookSpec} into an `.xlsx` buffer. */
export async function renderXlsx(spec: WorkbookSpec): Promise<Buffer> {
  const theme = resolveTheme(spec?.theme);
  const workbook = new ExcelJS.Workbook();

  workbook.creator = 'Celeste';
  workbook.lastModifiedBy = spec?.author ?? 'Celeste';
  workbook.title = spec?.title ?? 'Celeste Workbook';
  workbook.subject = spec?.title ?? 'Celeste Workbook';
  workbook.description = spec?.title ?? 'Celeste Workbook';
  workbook.company = 'Celeste';
  workbook.manager = 'Celeste';
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;

  const sheets = Array.isArray(spec?.sheets) ? spec.sheets : [];
  const usedNames = new Set<string>();
  sheets.forEach((sheet, index) => {
    const name = uniqueSheetName(sheet?.name ?? `Sheet${index + 1}`, usedNames);
    workbook.addWorksheet(name, {
      views: [{ state: 'frozen', ySplit: 1 }],
      properties: { defaultRowHeight: 18 },
    });
    fillSheet(workbook.getWorksheet(name)!, sheet, theme);
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/* -------------------------------------------------------------------------- */
/* Sheet filling                                                              */
/* -------------------------------------------------------------------------- */

function fillSheet(
  worksheet: ExcelJS.Worksheet,
  sheet: SheetSpec,
  theme: ResolvedTheme,
): void {
  const columns = Array.isArray(sheet?.columns) ? sheet.columns : [];
  const rows = Array.isArray(sheet?.rows) ? sheet.rows : [];
  const accent = normaliseHex(theme.accentColor) ?? '4F46E5';

  /* --- optional merged title row ---------------------------------------- */
  const hasTitle = typeof sheet?.title === 'string' && sheet.title.trim().length > 0;
  const headerRowNumber = hasTitle ? 2 : 1;

  if (hasTitle) {
    const titleCell = worksheet.getCell(1, 1);
    titleCell.value = sheet.title;
    titleCell.font = { bold: true, size: 14, color: { argb: `FF${accent}` } };
    titleCell.alignment = { vertical: 'middle' };
    worksheet.getRow(1).height = 24;
    if (columns.length > 1) {
      worksheet.mergeCells(1, 1, 1, columns.length);
    }
  }

  /* --- header row -------------------------------------------------------- */
  const headerRow = worksheet.getRow(headerRowNumber);
  headerRow.values = columns.map((column) => column.header ?? column.key ?? '');
  headerRow.font = { bold: true, color: { argb: 'FF111827' }, size: 11 };
  headerRow.alignment = { vertical: 'middle', wrapText: false };
  headerRow.height = 20;
  columns.forEach((column, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${tint(accent)}` } };
    cell.border = {
      top: { style: 'thin', color: { argb: `FF${accent}` } },
      bottom: { style: 'thin', color: { argb: `FF${accent}` } },
      left: { style: 'thin', color: { argb: 'FFD4D4D8' } },
      right: { style: 'thin', color: { argb: 'FFD4D4D8' } },
    };
  });

  /* --- data rows --------------------------------------------------------- */
  rows.forEach((record, rowIndex) => {
    const rowNumber = headerRowNumber + 1 + rowIndex;
    const row = worksheet.getRow(rowNumber);
    columns.forEach((column, columnIndex) => {
      const cell = row.getCell(columnIndex + 1);
      const raw = record ? record[column.key] : undefined;
      applyValue(cell, raw, column);
    });
  });

  /* --- column widths ----------------------------------------------------- */
  columns.forEach((column, columnIndex) => {
    const width = column.width ?? inferWidth(column, rows);
    worksheet.getColumn(columnIndex + 1).width = Math.min(MAX_COLUMN_WIDTH, Math.max(6, width));
  });

  /* --- freeze panes & autofilter ----------------------------------------- */
  const freezeHeader = sheet?.freezeHeader ?? true;
  worksheet.views = freezeHeader
    ? [{ state: 'frozen', ySplit: headerRowNumber }]
    : [{ state: 'normal' }];

  const useAutoFilter = sheet?.autoFilter ?? true;
  if (useAutoFilter && columns.length > 0) {
    const lastRow = Math.max(headerRowNumber, headerRowNumber + rows.length);
    worksheet.autoFilter = {
      from: { row: headerRowNumber, column: 1 },
      to: { row: lastRow, column: columns.length },
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Values & widths                                                            */
/* -------------------------------------------------------------------------- */

/** Write a value into a cell, honouring the column's declared type. */
function applyValue(cell: ExcelJS.Cell, raw: unknown, column: SheetColumn): void {
  const type = column.type ?? 'string';

  if (raw === null || raw === undefined) {
    cell.value = null;
    return;
  }

  switch (type) {
    case 'number': {
      const numeric = typeof raw === 'number' ? raw : Number(asText(raw));
      cell.value = Number.isFinite(numeric) ? numeric : asText(raw);
      if (typeof cell.value === 'number') cell.numFmt = '#,##0.####';
      return;
    }
    case 'boolean': {
      if (typeof raw === 'boolean') {
        cell.value = raw;
        return;
      }
      const text = asText(raw).trim().toLowerCase();
      cell.value = text === 'true' || text === '1' || text === 'yes';
      return;
    }
    case 'date': {
      const date = toDate(raw);
      if (date) {
        cell.value = date;
        cell.numFmt = 'yyyy-mm-dd';
      } else {
        cell.value = asText(raw);
      }
      return;
    }
    case 'url': {
      const url = asText(raw);
      cell.value = url ? { text: url, hyperlink: url } : '';
      cell.font = { color: { argb: 'FF2563EB' }, underline: true };
      return;
    }
    case 'string':
    default: {
      cell.value = asText(raw);
      return;
    }
  }
}

/** Coerce a value into a `Date`, when possible. */
function toDate(raw: unknown): Date | null {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // Excel's day zero is 1899-12-30.
    const date = new Date(Date.UTC(1899, 11, 30) + raw * 86_400_000);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const text = asText(raw).trim();
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Guess a column width from the header and the cell content. */
function inferWidth(column: SheetColumn, rows: Record<string, unknown>[]): number {
  let longest = (column.header ?? '').length;
  for (const row of rows) {
    const value = row ? row[column.key] : undefined;
    if (value === null || value === undefined) continue;
    const length = asText(value).length;
    if (length > longest) longest = length;
  }
  return longest + 3;
}

/* -------------------------------------------------------------------------- */
/* Sheet names                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Turn an arbitrary label into a valid, unique Excel sheet name:
 * at most 31 characters, no `[]:*?/\`, never empty.
 */
export function uniqueSheetName(name: string, used: Set<string>): string {
  const cleaned = (name ?? '')
    .replace(INVALID_SHEET_NAME_CHARS, ' ')
    .replace(/'/g, '')
    .trim();
  let base = cleaned.length > 0 ? cleaned : 'Sheet';
  if (base.length > MAX_SHEET_NAME) {
    base = base.slice(0, MAX_SHEET_NAME).trim();
  }

  let candidate = base;
  let counter = 1;
  while (used.has(candidate.toLowerCase())) {
    const suffix = ` ${counter}`;
    const room = Math.max(1, MAX_SHEET_NAME - suffix.length);
    candidate = `${base.slice(0, room).trim()}${suffix}`;
    counter += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/** A very light tint of the accent colour, used for header fills. */
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
