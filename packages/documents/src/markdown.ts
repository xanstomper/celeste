/**
 * Markdown and HTML renderers.
 *
 * Both walk the same {@link DocumentSpec}; Markdown is the plain-text
 * interchange format, HTML is the self-contained, styled document.
 */

import {
  asText,
  blockText,
  escapeHtml,
  escapeMarkdown,
  formatDocumentDate,
  headingLevel,
  imageOf,
  keyValueOf,
  listDepth,
  normaliseBlocks,
  resolveTheme,
  tableOf,
} from './blocks.js';
import type { DocBlock, DocumentSpec } from './types.js';

/* -------------------------------------------------------------------------- */
/* Markdown                                                                   */
/* -------------------------------------------------------------------------- */

/** Render a {@link DocumentSpec} as Markdown. */
export function renderMarkdown(spec: DocumentSpec): string {
  const header: string[] = [];
  const title = spec?.title?.trim();
  if (title) header.push(`# ${title}`);

  const subtitle = spec?.subtitle?.trim();
  if (subtitle) header.push(`*${subtitle}*`);

  const byline: string[] = [];
  if (spec?.author?.trim()) byline.push(spec.author.trim());
  const date = formatDocumentDate(spec?.date);
  if (date) byline.push(date);
  if (byline.length > 0) header.push(byline.join(' · '));

  const metadata = spec?.metadata ?? {};
  const metadataEntries = Object.entries(metadata).filter(([key]) => key.trim().length > 0);
  if (metadataEntries.length > 0) {
    if (header.length > 0) header.push('');
    for (const [key, value] of metadataEntries) {
      header.push(`- **${escapeMarkdown(key)}**: ${escapeMarkdown(asText(value))}`);
    }
  }

  const body: string[] = [];
  for (const block of normaliseBlocks(spec)) {
    const rendered = markdownBlock(block);
    if (rendered !== null) body.push(rendered);
  }

  const sections = [header.join('\n'), body.join('\n\n')].filter(
    (section) => section.trim().length > 0,
  );
  return `${sections.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/** Render one block as Markdown, or `null` when it contributes nothing. */
function markdownBlock(block: DocBlock): string | null {
  switch (block.type) {
    case 'heading': {
      const level = headingLevel(block);
      const text = emphasise(escapeMarkdown(blockText(block)), block);
      return `${'#'.repeat(level)} ${text}`;
    }
    case 'paragraph':
      return emphasise(escapeMarkdown(blockText(block)), block);
    case 'bullet': {
      const indent = '  '.repeat(listDepth(block));
      const text = emphasise(escapeMarkdown(blockText(block)), block);
      return `${indent}- ${text}`;
    }
    case 'numbered': {
      const indent = '  '.repeat(listDepth(block));
      const text = emphasise(escapeMarkdown(blockText(block)), block);
      return `${indent}1. ${text}`;
    }
    case 'code': {
      const language = block.language?.trim() ?? '';
      const body = blockText(block);
      return `\`\`\`${language}\n${body}\n\`\`\``;
    }
    case 'table': {
      const table = tableOf(block);
      if (!table) return null;
      const columnCount = Math.max(
        table.headers.length,
        table.rows.reduce((max, row) => Math.max(max, row.length), 0),
      );
      if (columnCount === 0) return null;
      const headers = Array.from({ length: columnCount }, (_unused, index) =>
        escapeMarkdown(table.headers[index] ?? ''),
      );
      const separator = Array.from({ length: columnCount }, () => '---');
      const rows = table.rows.map((row) =>
        `| ${Array.from({ length: columnCount }, (_unused, index) =>
          escapeMarkdown(row[index] ?? ''),
        ).join(' | ')} |`,
      );
      const parts = [`| ${headers.join(' | ')} |`, `| ${separator.join(' | ')} |`, ...rows];
      if (table.caption) parts.push(`*${escapeMarkdown(table.caption)}*`);
      return parts.join('\n');
    }
    case 'quote': {
      const text = blockText(block)
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
      const attribution = block.attribution?.trim();
      if (attribution) {
        return `${text}\n>\n> — ${escapeMarkdown(attribution)}`;
      }
      return text;
    }
    case 'divider':
      return '---';
    case 'pagebreak':
      return '<!-- pagebreak -->';
    case 'image': {
      const image = imageOf(block);
      if (!image) return null;
      const alt = image.alt ?? image.caption ?? '';
      const line = `![${escapeMarkdown(alt)}](${image.src})`;
      if (image.caption) return `${line}\n\n*${escapeMarkdown(image.caption)}*`;
      return line;
    }
    case 'keyvalue': {
      const kv = keyValueOf(block);
      if (!kv || kv.entries.length === 0) return null;
      return kv.entries
        .map((entry) => `- **${escapeMarkdown(entry.key)}**: ${escapeMarkdown(entry.value)}`)
        .join('\n');
    }
    default:
      return null;
  }
}

/** Apply the block's bold/italic flags to already escaped text. */
function emphasise(text: string, block: DocBlock): string {
  let out = text;
  if (block.italic) out = `*${out}*`;
  if (block.bold) out = `**${out}**`;
  return out;
}

/* -------------------------------------------------------------------------- */
/* HTML                                                                       */
/* -------------------------------------------------------------------------- */

/** Render a {@link DocumentSpec} as a self-contained HTML document. */
export function renderHtml(spec: DocumentSpec): string {
  const theme = resolveTheme(spec?.theme);
  const accent = `#${theme.accentColor}`;
  const title = spec?.title?.trim() ?? 'Untitled document';
  const subtitle = spec?.subtitle?.trim();
  const date = formatDocumentDate(spec?.date);

  const metaTags = Object.entries(spec?.metadata ?? {})
    .filter(([key]) => key.trim().length > 0)
    .map(
      ([key, value]) =>
        `  <meta name="${escapeHtml(key)}" content="${escapeHtml(asText(value))}">`,
    )
    .join('\n');

  const body: string[] = [];
  if (title) {
    body.push(`  <h1 class="doc-title">${escapeHtml(title)}</h1>`);
  }
  if (subtitle) {
    body.push(`  <p class="doc-subtitle">${escapeHtml(subtitle)}</p>`);
  }
  const byline: string[] = [];
  if (spec?.author?.trim()) byline.push(escapeHtml(spec.author.trim()));
  if (date) byline.push(escapeHtml(date));
  if (byline.length > 0) {
    body.push(`  <p class="doc-byline">${byline.join(' &middot; ')}</p>`);
  }

  body.push(...htmlBlocks(normaliseBlocks(spec)));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
${metaTags}
  <style>
    :root {
      --accent: ${accent};
      --ink: #111827;
      --muted: #6b7280;
      --rule: #e5e7eb;
      --code-bg: #f4f4f5;
    }
    * { box-sizing: border-box; }
    html { -webkit-text-size-adjust: 100%; }
    body {
      margin: 0;
      padding: 3rem 1.25rem 5rem;
      background: #ffffff;
      color: var(--ink);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: ${theme.fontSize + 2}px;
      line-height: 1.65;
    }
    main {
      max-width: 46rem;
      margin: 0 auto;
    }
    .doc-title {
      margin: 0 0 .35rem;
      font-size: 2.1rem;
      line-height: 1.2;
      letter-spacing: -0.02em;
      color: var(--accent);
    }
    .doc-subtitle {
      margin: 0 0 .5rem;
      color: var(--muted);
      font-size: 1.1rem;
      font-style: italic;
    }
    .doc-byline {
      margin: 0 0 2.25rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid var(--rule);
      color: var(--muted);
      font-size: .85rem;
    }
    h1, h2, h3, h4, h5, h6 {
      margin: 2rem 0 .6rem;
      line-height: 1.25;
      letter-spacing: -0.01em;
    }
    h1 { font-size: 1.6rem; color: var(--accent); }
    h2 { font-size: 1.35rem; }
    h3 { font-size: 1.15rem; }
    h4, h5, h6 { font-size: 1rem; }
    p { margin: 0 0 1rem; }
    ul, ol { margin: 0 0 1rem; padding-left: 1.5rem; }
    li { margin: .25rem 0; }
    a { color: var(--accent); }
    blockquote {
      margin: 1.25rem 0;
      padding: .1rem 0 .1rem 1rem;
      border-left: 3px solid var(--accent);
      color: #374151;
      font-style: italic;
    }
    blockquote p:last-child { margin-bottom: 0; }
    .attribution { color: var(--muted); font-size: .9rem; }
    hr {
      margin: 2rem 0;
      border: 0;
      border-top: 1px solid var(--rule);
    }
    pre {
      margin: 0 0 1.25rem;
      padding: .9rem 1rem;
      overflow-x: auto;
      background: var(--code-bg);
      border-left: 3px solid var(--accent);
      border-radius: 4px;
      font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
      font-size: .875rem;
      line-height: 1.5;
    }
    code {
      padding: .1rem .3rem;
      background: var(--code-bg);
      border-radius: 3px;
      font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
      font-size: .875em;
    }
    pre code { padding: 0; background: none; }
    table {
      width: 100%;
      margin: 0 0 1.25rem;
      border-collapse: collapse;
      font-size: .95rem;
    }
    th, td {
      padding: .5rem .65rem;
      border: 1px solid var(--rule);
      text-align: left;
      vertical-align: top;
    }
    th { background: #f8fafc; font-weight: 600; }
    .caption {
      margin: -.6rem 0 1.25rem;
      color: var(--muted);
      font-size: .85rem;
    }
    figure { margin: 0 0 1.5rem; }
    figure img { max-width: 100%; height: auto; border-radius: 4px; }
    .kv { margin: 0 0 1.25rem; }
    .kv dt { font-weight: 600; margin-top: .6rem; }
    .kv dd { margin: 0 0 .2rem; color: #374151; }
    .pagebreak { break-after: page; page-break-after: always; }
    @media print {
      body { padding: 0; font-size: 11pt; }
    }
  </style>
</head>
<body>
  <main>
${body.join('\n')}
  </main>
</body>
</html>
`;
}

/**
 * Render a run of blocks as HTML fragments, grouping consecutive list items
 * into a single (possibly nested) `<ul>` / `<ol>`.
 */
function htmlBlocks(blocks: DocBlock[]): string[] {
  const out: string[] = [];
  let index = 0;
  while (index < blocks.length) {
    const block = blocks[index];
    if (block && (block.type === 'bullet' || block.type === 'numbered')) {
      const type = block.type;
      const group: DocBlock[] = [];
      while (index < blocks.length) {
        const current = blocks[index];
        if (!current || current.type !== type) break;
        group.push(current);
        index += 1;
      }
      out.push(`  ${buildHtmlList(group, type)}`);
      continue;
    }
    const rendered = block ? htmlBlock(block) : null;
    if (rendered !== null) out.push(`  ${rendered}`);
    index += 1;
  }
  return out;
}

/** Build a nested `<ul>` / `<ol>` from a flat run of list blocks. */
function buildHtmlList(items: DocBlock[], type: 'bullet' | 'numbered'): string {
  const tag = type === 'bullet' ? 'ul' : 'ol';
  const rendered: string[] = [];
  let index = 0;
  while (index < items.length) {
    const item = items[index];
    if (!item) break;
    const depth = listDepth(item);
    const children: DocBlock[] = [];
    let cursor = index + 1;
    while (cursor < items.length) {
      const candidate = items[cursor];
      if (!candidate || listDepth(candidate) <= depth) break;
      children.push(candidate);
      cursor += 1;
    }
    const nested = children.length > 0 ? `\n${buildHtmlList(children, type)}` : '';
    rendered.push(
      `<li>${htmlEmphasise(escapeHtml(blockText(item)), item)}${nested}</li>`,
    );
    index = cursor;
  }
  return `<${tag}>\n      ${rendered.join('\n      ')}\n    </${tag}>`;
}

/** Render one block as an HTML fragment, or `null` when it contributes nothing. */
function htmlBlock(block: DocBlock): string | null {
  switch (block.type) {
    case 'heading': {
      const level = headingLevel(block);
      const text = htmlEmphasise(escapeHtml(blockText(block)), block);
      return `<h${level}>${text}</h${level}>`;
    }
    case 'paragraph':
      return `<p>${htmlEmphasise(escapeHtml(blockText(block)), block)}</p>`;
    case 'bullet':
    case 'numbered': {
      // Handled by buildHtmlList; kept for direct calls.
      const depth = listDepth(block);
      const text = htmlEmphasise(escapeHtml(blockText(block)), block);
      const tag = block.type === 'bullet' ? 'ul' : 'ol';
      return `<${tag} data-depth="${depth}"><li>${text}</li></${tag}>`;
    }
    case 'code': {
      const language = escapeHtml(block.language?.trim() ?? '');
      const body = escapeHtml(blockText(block));
      return `<pre><code class="language-${language}">${body}</code></pre>`;
    }
    case 'table': {
      const table = tableOf(block);
      if (!table) return null;
      const columnCount = Math.max(
        table.headers.length,
        table.rows.reduce((max, row) => Math.max(max, row.length), 0),
      );
      if (columnCount === 0) return null;
      const head = Array.from({ length: columnCount }, (_unused, index) =>
        `<th>${escapeHtml(table.headers[index] ?? '')}</th>`,
      ).join('');
      const bodyRows = table.rows
        .map(
          (row) =>
            `<tr>${Array.from({ length: columnCount }, (_unused, index) =>
              `<td>${escapeHtml(row[index] ?? '')}</td>`,
            ).join('')}</tr>`,
        )
        .join('\n');
      const caption = table.caption
        ? `<p class="caption">${escapeHtml(table.caption)}</p>`
        : '';
      return `<table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${bodyRows}\n</tbody>\n</table>\n${caption}`;
    }
    case 'quote': {
      const text = escapeHtml(blockText(block));
      const attribution = block.attribution?.trim();
      const attributionHtml = attribution
        ? `<p class="attribution">&mdash; ${escapeHtml(attribution)}</p>`
        : '';
      return `<blockquote><p>${text}</p>${attributionHtml}</blockquote>`;
    }
    case 'divider':
      return '<hr>';
    case 'pagebreak':
      return '<div class="pagebreak"></div>';
    case 'image': {
      const image = imageOf(block);
      if (!image) return null;
      const alt = escapeHtml(image.alt ?? image.caption ?? '');
      const src = escapeHtml(image.src);
      const caption = image.caption
        ? `<figcaption>${escapeHtml(image.caption)}</figcaption>`
        : '';
      return `<figure><img src="${src}" alt="${alt}">${caption}</figure>`;
    }
    case 'keyvalue': {
      const kv = keyValueOf(block);
      if (!kv || kv.entries.length === 0) return null;
      const items = kv.entries
        .map(
          (entry) =>
            `<dt>${escapeHtml(entry.key)}</dt>\n      <dd>${escapeHtml(entry.value)}</dd>`,
        )
        .join('\n      ');
      return `<dl class="kv">\n      ${items}\n    </dl>`;
    }
    default:
      return null;
  }
}

/** Apply the block's bold/italic flags to already escaped HTML. */
function htmlEmphasise(text: string, block: DocBlock): string {
  let out = text;
  if (block.italic) out = `<em>${out}</em>`;
  if (block.bold) out = `<strong>${out}</strong>`;
  return out;
}

/* -------------------------------------------------------------------------- */
/* Plain text                                                                 */
/* -------------------------------------------------------------------------- */

/** Render a {@link DocumentSpec} as plain text (the `.txt` output). */
export function renderText(spec: DocumentSpec): string {
  const out: string[] = [];
  const title = spec?.title?.trim();
  if (title) out.push(title);
  const subtitle = spec?.subtitle?.trim();
  if (subtitle) out.push(subtitle);
  const byline: string[] = [];
  if (spec?.author?.trim()) byline.push(spec.author.trim());
  const date = formatDocumentDate(spec?.date);
  if (date) byline.push(date);
  if (byline.length > 0) out.push(byline.join('  -  '));
  out.push('');

  const counters: number[] = [];
  for (const block of normaliseBlocks(spec)) {
    if (block.type === 'numbered') {
      const depth = listDepth(block);
      while (counters.length <= depth) counters.push(0);
      counters[depth] = (counters[depth] ?? 0) + 1;
      for (let index = depth + 1; index < counters.length; index += 1) counters[index] = 0;
    } else {
      counters.length = 0;
    }
    const rendered = textBlock(block, counters);
    if (rendered !== null) out.push(rendered);
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/** Render one block as plain text, or `null` when it contributes nothing. */
function textBlock(block: DocBlock, counters: number[]): string | null {
  switch (block.type) {
    case 'heading': {
      const level = headingLevel(block);
      return `${blockText(block).toUpperCase()}\n${'='.repeat(Math.min(60, blockText(block).length))}`;
    }
    case 'paragraph':
      return blockText(block);
    case 'bullet':
      return `${'  '.repeat(listDepth(block))}- ${blockText(block)}`;
    case 'numbered': {
      const depth = listDepth(block);
      return `${'  '.repeat(depth)}${counters[depth] ?? 1}. ${blockText(block)}`;
    }
    case 'code':
      return blockText(block)
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n');
    case 'table': {
      const table = tableOf(block);
      if (!table) return null;
      const columnCount = Math.max(
        table.headers.length,
        table.rows.reduce((max, row) => Math.max(max, row.length), 0),
      );
      if (columnCount === 0) return null;
      const header = Array.from({ length: columnCount }, (_unused, index) =>
        (table.headers[index] ?? '').padEnd(16),
      ).join('');
      const rows = table.rows.map((row) =>
        Array.from({ length: columnCount }, (_unused, index) =>
          (row[index] ?? '').padEnd(16),
        ).join(''),
      );
      return [header, ...rows].join('\n');
    }
    case 'quote': {
      const attribution = block.attribution?.trim();
      const body = blockText(block)
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n');
      return attribution ? `${body}\n  -- ${attribution}` : body;
    }
    case 'divider':
      return '-'.repeat(60);
    case 'pagebreak':
      return '\f';
    case 'image': {
      const image = imageOf(block);
      if (!image) return null;
      return image.caption ? `[image: ${image.caption}]` : '[image]';
    }
    case 'keyvalue': {
      const kv = keyValueOf(block);
      if (!kv || kv.entries.length === 0) return null;
      return kv.entries.map((entry) => `${entry.key}: ${entry.value}`).join('\n');
    }
    default:
      return null;
  }
}
