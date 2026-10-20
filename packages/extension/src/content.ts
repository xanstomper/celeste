/**
 * Celeste content script (isolated world).
 *
 * The background worker talks to this script through two channels:
 *
 *  1. `chrome.tabs.sendMessage` — the fast path used by the dispatcher.
 *  2. `window.__celeste.invoke(...)` — a function-injection bridge used as a
 *     fallback when the content script was injected after the page loaded.
 *
 * Responsibilities:
 *  - element references (`e12`) + a compact, model friendly accessibility tree
 *  - semantic tree compression (ads / boilerplate removal) for text + markdown
 *  - realistic interaction (click / type / press / select …) that works with
 *    React-controlled inputs
 *  - challenge & session-expiry detection
 *  - DOM mutation reporting
 *
 * The script is intentionally dependency free: it runs in every page the user
 * visits, so it must stay small and must never throw into the host page.
 */

import type { ElementRef, ProtocolErrorShape, SnapshotElement, ToolErrorCode } from './protocol.js';
import { CONTENT_CHANNEL } from './types.js';
import type { ContentRequest, ContentResponse } from './types.js';

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

class ContentError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ContentError';
  }
}

function toErrorShape(err: unknown): ProtocolErrorShape {
  if (err instanceof ContentError) {
    return { code: err.code, message: err.message, retryable: err.retryable };
  }
  if (err instanceof Error) {
    return { code: 'INTERNAL', message: err.message, retryable: false };
  }
  return { code: 'INTERNAL', message: String(err), retryable: false };
}

/* -------------------------------------------------------------------------- */
/* Element references                                                         */
/* -------------------------------------------------------------------------- */

/** Refs for the *current* snapshot. Rebuilt on every `snapshot` call. */
const refs = new Map<string, HTMLElement>();
/**
 * Grace archive: refs from previous snapshots stay resolvable so a model that
 * clicks a slightly stale ref still works. Bounded to avoid leaks.
 */
const archive = new Map<string, HTMLElement>();
const MAX_ARCHIVE = 2000;

let refCounter = 0;

function nextRef(): string {
  refCounter += 1;
  return `e${refCounter}`;
}

function resolveElement(ref: string | undefined): HTMLElement | undefined {
  if (!ref) return undefined;
  const current = refs.get(ref);
  if (current && current.isConnected) return current;
  const old = archive.get(ref);
  if (old && old.isConnected) return old;
  return undefined;
}

function requireElement(ref: string | undefined, what = 'element'): HTMLElement {
  const el = resolveElement(ref);
  if (!el) {
    throw new ContentError('ELEMENT_NOT_FOUND', `No ${what} for ref "${ref ?? '(none)'}" — take a snapshot first.`);
  }
  return el;
}

/* -------------------------------------------------------------------------- */
/* Role + accessible name                                                     */
/* -------------------------------------------------------------------------- */

const IMPLICIT_ROLES: Record<string, string> = {
  a: 'link',
  area: 'link',
  article: 'article',
  aside: 'complementary',
  button: 'button',
  datalist: 'listbox',
  dd: 'definition',
  details: 'group',
  dialog: 'dialog',
  dt: 'term',
  fieldset: 'group',
  figure: 'figure',
  footer: 'contentinfo',
  form: 'form',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  header: 'banner',
  hr: 'separator',
  img: 'img',
  input: 'textbox',
  li: 'listitem',
  main: 'main',
  menu: 'list',
  meter: 'meter',
  nav: 'navigation',
  ol: 'list',
  optgroup: 'group',
  option: 'option',
  output: 'status',
  progress: 'progressbar',
  section: 'region',
  select: 'combobox',
  summary: 'button',
  table: 'table',
  tbody: 'rowgroup',
  td: 'cell',
  textarea: 'textbox',
  tfoot: 'rowgroup',
  th: 'columnheader',
  thead: 'rowgroup',
  tr: 'row',
  ul: 'list',
};

const INPUT_ROLES: Record<string, string> = {
  button: 'button',
  checkbox: 'checkbox',
  color: 'textbox',
  date: 'textbox',
  'datetime-local': 'textbox',
  email: 'textbox',
  file: 'button',
  hidden: 'none',
  image: 'button',
  month: 'textbox',
  number: 'spinbutton',
  password: 'textbox',
  radio: 'radio',
  range: 'slider',
  reset: 'button',
  search: 'searchbox',
  submit: 'button',
  tel: 'textbox',
  text: 'textbox',
  time: 'textbox',
  url: 'textbox',
  week: 'textbox',
};

function computeRole(el: Element): string {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit.trim().split(/\s+/)[0] ?? 'generic';
  const tag = el.tagName.toLowerCase();
  if (tag === 'input') {
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    return INPUT_ROLES[type] ?? 'textbox';
  }
  return IMPLICIT_ROLES[tag] ?? 'generic';
}

function collapse(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function computeName(el: Element): string {
  const ariaLabel = collapse(el.getAttribute('aria-label'));
  if (ariaLabel) return ariaLabel;

  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = collapse(
      labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' '),
    );
    if (text) return text;
  }

  const alt = collapse(el.getAttribute('alt'));
  if (alt) return alt;

  const placeholder = collapse(el.getAttribute('placeholder'));
  if (placeholder) return placeholder;

  const id = el.getAttribute('id');
  if (id) {
    let label: HTMLLabelElement | null = null;
    try {
      label = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(id)}"]`);
    } catch {
      label = null;
    }
    const labelText = collapse(label?.textContent);
    if (labelText) return labelText;
  }

  const wrapping = el.closest('label');
  const wrappingText = collapse(wrapping?.textContent);
  if (wrappingText) return wrappingText;

  const own = collapse(el.textContent);
  if (own && own.length <= 200) return own;

  const title = collapse(el.getAttribute('title'));
  if (title) return title;

  const name = collapse(el.getAttribute('name'));
  if (name) return name;

  const value = (el as HTMLInputElement).value;
  if (typeof value === 'string') {
    const trimmed = collapse(value);
    if (trimmed) return trimmed.slice(0, 120);
  }

  return '';
}

/* -------------------------------------------------------------------------- */
/* Visibility                                                                 */
/* -------------------------------------------------------------------------- */

function isVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement) && !(el instanceof SVGElement)) return false;
  if (el.hasAttribute('hidden')) return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none') return false;
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  if (style.opacity !== '' && Number(style.opacity) === 0) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 && rect.height <= 0) return false;
  return true;
}

function boxOf(el: Element): { x: number; y: number; width: number; height: number } {
  const rect = el.getBoundingClientRect();
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

/* -------------------------------------------------------------------------- */
/* Noise / boilerplate detection                                              */
/* -------------------------------------------------------------------------- */

/**
 * Matches class/id tokens that are almost certainly boilerplate.
 *
 * The boundaries matter: `header` contains "ad" but must never be dropped, so
 * the pattern only fires on whole tokens separated by `-`, `_` or whitespace.
 */
const NOISE_TOKEN_RE =
  /(^|[\s\-_])(ad|ads|adslot|advert|advertisement|advertising|sponsor|sponsored|promo|cookie|cookies|consent|gdpr|newsletter|subscribe|subscription|popup|popups|modal|overlay|lightbox|social|share|sharing|sidebar|related|comment|comments|disqus|banner|paywall|skip-link|breadcrumbs)([\s\-_]|$)/i;

const NOISE_SELECTORS = [
  'script',
  'style',
  'noscript',
  'template',
  'link',
  'meta',
  'iframe[src*="doubleclick"]',
  'iframe[src*="googlesyndication"]',
  'iframe[src*="google-analytics"]',
  'iframe[src*="facebook.com/plugins"]',
  '[aria-hidden="true"]',
  '[hidden]',
];

function isNoiseElement(el: Element): boolean {
  const classAttr = el.getAttribute('class');
  if (classAttr && NOISE_TOKEN_RE.test(classAttr)) return true;
  const idAttr = el.getAttribute('id');
  if (idAttr && NOISE_TOKEN_RE.test(idAttr)) return true;
  return false;
}

/* -------------------------------------------------------------------------- */
/* Snapshot                                                                   */
/* -------------------------------------------------------------------------- */

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'BASE', 'HEAD']);
const SVG_SKIP_TAGS = new Set(['PATH', 'DEFS', 'SYMBOL', 'CLIPPATH', 'MASK', 'LINEARGRADIENT', 'RADIALGRADIENT', 'STOP', 'FILTER', 'PATTERN', 'USE', 'MARKER']);

const INTERACTIVE_TAGS = new Set([
  'A',
  'BUTTON',
  'INPUT',
  'SELECT',
  'TEXTAREA',
  'OPTION',
  'LABEL',
  'SUMMARY',
  'DETAILS',
]);

const STRUCTURAL_TAGS = new Set([
  'MAIN',
  'NAV',
  'HEADER',
  'FOOTER',
  'ASIDE',
  'ARTICLE',
  'SECTION',
  'FORM',
  'TABLE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'IMG',
  'DIALOG',
  'FIELDSET',
  'VIDEO',
  'AUDIO',
]);

const ATTR_KEYS = [
  'id',
  'name',
  'type',
  'placeholder',
  'aria-label',
  'href',
  'value',
  'disabled',
  'checked',
  'selected',
  'title',
  'alt',
  'role',
  'target',
  'rel',
  'autocomplete',
  'required',
  'readonly',
  'maxlength',
  'src',
];

function collectAttrs(el: Element): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const key of ATTR_KEYS) {
    const value = el.getAttribute(key);
    if (value === null) continue;
    if (value === '' && key !== 'value' && key !== 'disabled' && key !== 'checked' && key !== 'required' && key !== 'readonly') {
      continue;
    }
    attrs[key] = value.length > 200 ? `${value.slice(0, 200)}…` : value;
  }
  return attrs;
}

function shouldInclude(el: Element): boolean {
  const tag = el.tagName.toUpperCase();
  if (INTERACTIVE_TAGS.has(tag)) return true;
  if (STRUCTURAL_TAGS.has(tag)) return true;
  if (el.getAttribute('role')) return true;
  if (el.hasAttribute('aria-label')) return true;
  if (el.hasAttribute('contenteditable')) return true;
  if (el.hasAttribute('onclick')) return true;
  if (tag === 'IMG' && el.getAttribute('alt')) return true;
  return false;
}

interface SnapshotOptions {
  maxElements?: number;
  includeText?: boolean;
}

function buildSnapshot(options: SnapshotOptions): {
  url: string;
  title: string;
  elements: SnapshotElement[];
  text?: string;
  challenge?: boolean;
  capturedAt: number;
} {
  const maxElements = Math.max(1, Math.min(options.maxElements ?? 400, 4000));
  const maxDepth = 30;

  refs.clear();
  refCounter = 0;
  archive.clear();

  const elements: SnapshotElement[] = [];
  const root = document.body ?? document.documentElement;

  const walk = (el: Element, depth: number): ElementRef | undefined => {
    if (elements.length >= maxElements) return undefined;
    if (depth > maxDepth) return undefined;

    const tag = el.tagName.toUpperCase();
    if (SKIP_TAGS.has(tag)) return undefined;
    if (el.namespaceURI === 'http://www.w3.org/2000/svg' && SVG_SKIP_TAGS.has(tag)) return undefined;

    let ref: ElementRef | undefined;
    let entry: SnapshotElement | undefined;

    if (shouldInclude(el)) {
      ref = nextRef();
      const html = el as HTMLElement;
      refs.set(ref, html);
      archive.set(ref, html);
      while (archive.size > MAX_ARCHIVE) {
        const oldest = archive.keys().next();
        if (oldest.done) break;
        archive.delete(oldest.value);
      }
      entry = {
        ref,
        role: computeRole(el),
        name: computeName(el),
        tag: el.tagName.toLowerCase(),
        visible: isVisible(el),
        box: boxOf(el),
        attrs: collectAttrs(el),
        children: [],
      };
      elements.push(entry);
    }

    const childRefs: ElementRef[] = [];
    for (const child of Array.from(el.children)) {
      const childRef = walk(child, depth + 1);
      if (childRef) childRefs.push(childRef);
    }

    if (entry && ref) entry.children = childRefs;
    return ref;
  };

  if (root) walk(root, 0);

  const challenge = detectChallenge();
  const result: {
    url: string;
    title: string;
    elements: SnapshotElement[];
    text?: string;
    challenge?: boolean;
    capturedAt: number;
  } = {
    url: location.href,
    title: document.title ?? '',
    elements,
    capturedAt: Date.now(),
  };
  if (challenge.detected) result.challenge = true;
  if (options.includeText !== false) {
    const text = cleanedText();
    if (text) result.text = text.slice(0, 8000);
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Text cleaning + markdown                                                   */
/* -------------------------------------------------------------------------- */

/** Removes boilerplate from a live DOM tree without mutating the page. */
function cleanClone(root: Element): Element {
  const clone = root.cloneNode(true) as Element;

  for (const selector of NOISE_SELECTORS) {
    clone.querySelectorAll(selector).forEach((node) => node.remove());
  }

  clone.querySelectorAll('*').forEach((node) => {
    if (isNoiseElement(node)) {
      node.remove();
      return;
    }
    const style = node.getAttribute('style');
    if (style && /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) node.remove();
  });

  // Drop chrome-level landmarks when a real content region exists.
  const hasMain =
    clone.querySelector('main, article, [role="main"], [role="article"], #content, .content, .post, .article') !== null;
  if (hasMain) {
    clone.querySelectorAll('nav, footer, aside').forEach((node) => node.remove());
  }

  return clone;
}

function cleanedText(selector?: string): string {
  const source = selector ? document.querySelector(selector) : document.body;
  if (!source) return '';
  const clone = cleanClone(source);
  const text = (clone as HTMLElement).innerText ?? clone.textContent ?? '';
  return collapse(text);
}

const BLOCK_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DD',
  'DETAILS',
  'DIV',
  'DL',
  'DT',
  'FIELDSET',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'FORM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'TABLE',
  'TBODY',
  'TD',
  'TFOOT',
  'TH',
  'THEAD',
  'TR',
  'UL',
]);

const SKIP_MARKDOWN_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME']);

function absoluteUrl(href: string): string {
  try {
    return new URL(href, location.href).href;
  } catch {
    return href;
  }
}

function renderInline(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as Element;
  const tag = el.tagName.toUpperCase();
  switch (tag) {
    case 'BR':
      return '\n';
    case 'IMG': {
      const alt = collapse(el.getAttribute('alt'));
      const src = el.getAttribute('src');
      return src ? `![${alt}](${absoluteUrl(src)})` : '';
    }
    case 'A': {
      const text = renderInlineChildren(el).trim();
      const href = el.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) return text;
      return `[${text || href}](${absoluteUrl(href)})`;
    }
    case 'STRONG':
    case 'B': {
      const text = renderInlineChildren(el).trim();
      return text ? `**${text}**` : '';
    }
    case 'EM':
    case 'I': {
      const text = renderInlineChildren(el).trim();
      return text ? `*${text}*` : '';
    }
    case 'CODE': {
      const text = (el.textContent ?? '').trim();
      return text ? `\`${text}\`` : '';
    }
    case 'DEL':
    case 'S':
    case 'STRIKE': {
      const text = renderInlineChildren(el).trim();
      return text ? `~~${text}~~` : '';
    }
    default:
      return renderInlineChildren(el);
  }
}

function renderInlineChildren(el: Element): string {
  let out = '';
  for (const child of Array.from(el.childNodes)) out += renderInline(child);
  return out;
}

function renderList(list: Element): string {
  const ordered = list.tagName.toUpperCase() === 'OL';
  const items = Array.from(list.children).filter((child) => child.tagName.toUpperCase() === 'LI');
  const lines: string[] = [];
  items.forEach((item, index) => {
    const marker = ordered ? `${index + 1}.` : '-';
    const nested = Array.from(item.children).filter((child) => {
      const tag = child.tagName.toUpperCase();
      return tag === 'UL' || tag === 'OL';
    });
    const body = renderInlineChildren(item).trim();
    lines.push(`${marker} ${body}`.trimEnd());
    for (const child of nested) {
      const nestedText = renderList(child as Element);
      if (nestedText) lines.push(nestedText.replace(/^/gm, '  '));
    }
  });
  return lines.join('\n');
}

function renderTable(table: Element): string {
  const rows = Array.from(table.querySelectorAll('tr')).filter((row) => row.closest('table') === table);
  if (rows.length === 0) return '';
  const cellText = (cell: Element): string => collapse(cell.textContent).replace(/\|/g, '\\|');
  const toCells = (row: Element): string[] =>
    Array.from(row.children)
      .filter((cell) => ['TH', 'TD'].includes(cell.tagName.toUpperCase()))
      .map(cellText);

  const firstCells = toCells(rows[0] as Element);
  if (firstCells.length === 0) return '';
  const lines: string[] = [];
  const hasHeader = (rows[0] as Element).querySelector('th') !== null;
  lines.push(`| ${firstCells.join(' | ')} |`);
  lines.push(`| ${firstCells.map(() => '---').join(' | ')} |`);
  const bodyRows = hasHeader ? rows.slice(1) : rows.slice(1);
  for (const row of bodyRows) {
    const cells = toCells(row);
    if (cells.length === 0) continue;
    lines.push(`| ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
}

function renderBlock(el: Element): string {
  const tag = el.tagName.toUpperCase();
  if (SKIP_MARKDOWN_TAGS.has(tag)) return '';

  switch (tag) {
    case 'H1':
    case 'H2':
    case 'H3':
    case 'H4':
    case 'H5':
    case 'H6': {
      const level = Number(tag.slice(1));
      const text = renderInlineChildren(el).trim();
      return text ? `${'#'.repeat(level)} ${text}` : '';
    }
    case 'P':
      return renderInlineChildren(el).trim();
    case 'HR':
      return '---';
    case 'PRE': {
      const code = (el.textContent ?? '').replace(/\n+$/, '');
      return `\`\`\`\n${code}\n\`\`\``;
    }
    case 'BLOCKQUOTE': {
      const inner = renderBlocks(el);
      return inner
        .split('\n')
        .map((line) => (line ? `> ${line}` : '>'))
        .join('\n');
    }
    case 'UL':
    case 'OL':
      return renderList(el);
    case 'TABLE':
      return renderTable(el);
    case 'IMG': {
      const alt = collapse(el.getAttribute('alt'));
      const src = el.getAttribute('src');
      return src ? `![${alt}](${absoluteUrl(src)})` : '';
    }
    case 'LI':
      return `- ${renderInlineChildren(el).trim()}`;
    default:
      return renderBlocks(el);
  }
}

function renderBlocks(container: Element): string {
  const chunks: string[] = [];
  let buffer: string[] = [];

  const flush = (): void => {
    const text = buffer.join('').trim();
    if (text) chunks.push(text);
    buffer = [];
  };

  for (const node of Array.from(container.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      buffer.push(node.textContent ?? '');
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (SKIP_MARKDOWN_TAGS.has(tag)) continue;
    if (BLOCK_TAGS.has(tag)) {
      flush();
      const rendered = renderBlock(el);
      if (rendered.trim()) chunks.push(rendered.trim());
    } else {
      buffer.push(renderInline(el));
    }
  }
  flush();
  return chunks.join('\n\n');
}

function pickMainRoot(selector?: string): Element | null {
  if (selector) return document.querySelector(selector);
  const candidates = [
    'main',
    'article',
    '[role="main"]',
    '[role="article"]',
    '#main',
    '#content',
    '.main-content',
    '.post-content',
    '.entry-content',
  ];
  for (const candidate of candidates) {
    const found = document.querySelector(candidate);
    if (found && (found.textContent ?? '').trim().length > 200) return found;
  }
  return document.body ?? document.documentElement;
}

function extractContent(selector?: string): {
  url: string;
  title: string;
  markdown: string;
  links: { text: string; href: string }[];
  metadata: Record<string, string>;
} {
  const root = pickMainRoot(selector);
  const metadata = collectMetadata();
  if (!root) {
    return {
      url: location.href,
      title: document.title ?? '',
      markdown: '',
      links: [],
      metadata,
    };
  }

  const clean = cleanClone(root);
  const markdown = renderBlocks(clean).replace(/\n{3,}/g, '\n\n').trim();

  const links: { text: string; href: string }[] = [];
  const seen = new Set<string>();
  root.querySelectorAll('a[href]').forEach((anchor) => {
    if (links.length >= 200) return;
    const href = anchor.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) return;
    const absolute = absoluteUrl(href);
    if (seen.has(absolute)) return;
    seen.add(absolute);
    links.push({ text: collapse(anchor.textContent).slice(0, 120), href: absolute });
  });

  return {
    url: location.href,
    title: document.title ?? '',
    markdown: markdown.slice(0, 120_000),
    links,
    metadata,
  };
}

function metaContent(selectors: string[]): string {
  for (const selector of selectors) {
    const node = document.querySelector(selector);
    const content = collapse(node?.getAttribute('content'));
    if (content) return content;
  }
  return '';
}

function collectMetadata(): Record<string, string> {
  const metadata: Record<string, string> = {};
  const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href');
  if (canonical) metadata['canonical'] = absoluteUrl(canonical);
  const values: Record<string, string> = {
    title: document.title ?? '',
    description: metaContent(['meta[name="description"]', 'meta[property="og:description"]']),
    ogTitle: metaContent(['meta[property="og:title"]']),
    ogDescription: metaContent(['meta[property="og:description"]']),
    ogImage: metaContent(['meta[property="og:image"]']),
    ogType: metaContent(['meta[property="og:type"]']),
    author: metaContent(['meta[name="author"]', 'meta[property="article:author"]']),
    siteName: metaContent(['meta[property="og:site_name"]']),
    lang: document.documentElement.lang ?? '',
    type: metaContent(['meta[property="og:type"]']),
  };
  for (const [key, value] of Object.entries(values)) {
    if (value) metadata[key] = value;
  }
  return metadata;
}

/* -------------------------------------------------------------------------- */
/* Challenge + session detection                                              */
/* -------------------------------------------------------------------------- */

const CHALLENGE_SELECTORS: { selector: string; kind: string }[] = [
  { selector: '#challenge-form', kind: 'cloudflare' },
  { selector: '.cf-browser-verification', kind: 'cloudflare' },
  { selector: '#cf-challenge-running', kind: 'cloudflare' },
  { selector: '#cf-wrapper', kind: 'cloudflare' },
  { selector: 'iframe[src*="challenges.cloudflare.com"]', kind: 'cloudflare' },
  { selector: '#px-captcha', kind: 'perimeterx' },
  { selector: '.px-captcha', kind: 'perimeterx' },
  { selector: 'iframe[src*="perimeterx"]', kind: 'perimeterx' },
  { selector: 'iframe[src*="recaptcha"]', kind: 'recaptcha' },
  { selector: '#g-recaptcha', kind: 'recaptcha' },
  { selector: '.g-recaptcha', kind: 'recaptcha' },
  { selector: 'iframe[src*="hcaptcha"]', kind: 'hcaptcha' },
  { selector: '.h-captcha', kind: 'hcaptcha' },
  { selector: '#captcha-container', kind: 'captcha' },
];

const CHALLENGE_TEXT_RE =
  /verify (?:that )?you are (?:a )?human|checking your browser|unusual traffic|complete the security check|are you a robot|just a moment/i;

function detectChallenge(): { detected: boolean; kind?: string; confidence: number } {
  for (const { selector, kind } of CHALLENGE_SELECTORS) {
    try {
      const node = document.querySelector(selector);
      if (node && isVisible(node)) {
        return { detected: true, kind, confidence: 0.95 };
      }
    } catch {
      /* invalid selector — ignore */
    }
  }

  const text = collapse(document.body?.innerText ?? '').slice(0, 4000);
  if (CHALLENGE_TEXT_RE.test(text)) {
    return { detected: true, kind: 'unknown', confidence: 0.6 };
  }
  return { detected: false, confidence: 0 };
}

const SESSION_URL_RE = /\/(?:login|signin|sign-in|logout|sign-out|auth|session\/expired)(?:[/?#]|$)/i;
const SESSION_TEXT_RE = /session (?:has )?expired|your session has ended|please (?:log|sign) in|please log in again/i;

function detectSessionExpiry(): { expired: boolean; reason?: string } {
  if (SESSION_URL_RE.test(location.pathname)) {
    return { expired: true, reason: `navigated to ${location.pathname}` };
  }
  const text = collapse(document.body?.innerText ?? '').slice(0, 3000);
  if (SESSION_TEXT_RE.test(text)) {
    return { expired: true, reason: 'page reports an expired session' };
  }
  return { expired: false };
}

/* -------------------------------------------------------------------------- */
/* Interaction                                                                */
/* -------------------------------------------------------------------------- */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mouseEventInit(x: number, y: number, button: number, buttons: number): MouseEventInit {
  return {
    view: window,
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: x,
    clientY: y,
    screenX: x,
    screenY: y,
    button,
    buttons,
    detail: 1,
  };
}

function centerOf(el: Element): { x: number; y: number } {
  const rect = el.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function clickElement(el: HTMLElement, button: 'left' | 'right' | 'middle' = 'left'): { x: number; y: number } {
  const numeric = button === 'right' ? 2 : button === 'middle' ? 1 : 0;
  try {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
  } catch {
    /* ignore */
  }
  const { x, y } = centerOf(el);
  const init = mouseEventInit(x, y, numeric, numeric === 0 ? 1 : 2);
  el.dispatchEvent(new MouseEvent('mousedown', init));
  el.dispatchEvent(new MouseEvent('mouseup', init));
  el.dispatchEvent(new MouseEvent('click', init));
  return { x, y };
}

const KEY_CODES: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Pause: 19,
  CapsLock: 20,
  Escape: 27,
  Space: 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Insert: 45,
  Delete: 46,
  Meta: 91,
  F1: 112,
  F2: 113,
  F3: 114,
  F4: 115,
  F5: 116,
  F6: 117,
  F7: 118,
  F8: 119,
  F9: 120,
  F10: 121,
  F11: 122,
  F12: 123,
};

function keyDescriptor(key: string): { key: string; code: string; keyCode: number } {
  const single = key.length === 1 ? key : key;
  const code = /^[a-zA-Z]$/.test(single)
    ? `Key${single.toUpperCase()}`
    : /^[0-9]$/.test(single)
      ? `Digit${single}`
      : single;
  const keyCode = KEY_CODES[single] ?? (single.length === 1 ? single.charCodeAt(0) : 0);
  return { key: single, code, keyCode };
}

function pressKeyOn(el: HTMLElement | null, key: string, modifiers: string[]): void {
  const target = el ?? (document.activeElement as HTMLElement | null) ?? document.body;
  const { key: keyName, code, keyCode } = keyDescriptor(key);
  const init: KeyboardEventInit = {
    key: keyName,
    code,
    keyCode,
    which: keyCode,
    bubbles: true,
    cancelable: true,
    composed: true,
    ctrlKey: modifiers.includes('Control'),
    altKey: modifiers.includes('Alt'),
    shiftKey: modifiers.includes('Shift'),
    metaKey: modifiers.includes('Meta'),
  };
  target.dispatchEvent(new KeyboardEvent('keydown', init));
  target.dispatchEvent(new KeyboardEvent('keypress', init));
  target.dispatchEvent(new KeyboardEvent('keyup', init));
}

function nativeValueSetter(el: HTMLInputElement | HTMLTextAreaElement): ((value: string) => void) | undefined {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  return descriptor?.set;
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const setter = nativeValueSetter(el);
  if (setter) setter.call(el, value);
  else el.value = value;
}

function isTextEntry(el: HTMLElement): el is HTMLInputElement | HTMLTextAreaElement {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

async function typeInto(
  el: HTMLElement,
  text: string,
  options: { clear?: boolean; delayMs?: number },
): Promise<{ typed: string }> {
  if (!isTextEntry(el)) {
    throw new ContentError('INVALID_ARGS', `Element <${el.tagName.toLowerCase()}> is not a text input.`);
  }
  const delay = Math.max(0, Math.min(options.delayMs ?? 0, 5000));
  el.focus();

  if (options.clear) {
    setNativeValue(el, '');
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
  }

  let current = el.value ?? '';
  for (const ch of text) {
    const key = keyDescriptor(ch);
    const keyInit: KeyboardEventInit = {
      key: key.key,
      code: key.code,
      keyCode: key.keyCode,
      which: key.keyCode,
      bubbles: true,
      cancelable: true,
      composed: true,
    };
    el.dispatchEvent(new KeyboardEvent('keydown', keyInit));

    el.dispatchEvent(
      new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: ch }),
    );

    current += ch;
    setNativeValue(el, current);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));

    el.dispatchEvent(new KeyboardEvent('keyup', keyInit));

    if (delay > 0) await sleep(delay);
  }

  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { typed: text };
}

function fillInto(el: HTMLElement, value: string): void {
  if (!isTextEntry(el)) {
    throw new ContentError('INVALID_ARGS', `Element <${el.tagName.toLowerCase()}> is not a text input.`);
  }
  el.focus();
  setNativeValue(el, value);
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function selectOption(el: HTMLElement, value: string): { selected: string } {
  if (!(el instanceof HTMLSelectElement)) {
    throw new ContentError('INVALID_ARGS', `Element <${el.tagName.toLowerCase()}> is not a <select>.`);
  }
  const options = Array.from(el.options);
  const match =
    options.find((option) => option.value === value) ??
    options.find((option) => collapse(option.textContent) === value) ??
    options.find((option) => collapse(option.label) === value);
  if (!match) {
    throw new ContentError('NOT_FOUND', `No option "${value}" in <select>.`);
  }
  el.value = match.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { selected: match.value };
}

async function waitForElement(params: { selector?: string; text?: string; timeoutMs?: number }): Promise<{
  found: boolean;
  selector?: string;
  text?: string;
}> {
  const timeout = Math.max(100, Math.min(params.timeoutMs ?? 15_000, 300_000));
  const deadline = Date.now() + timeout;
  const selector = params.selector;
  const text = params.text;

  while (Date.now() < deadline) {
    if (selector) {
      let node: Element | null = null;
      try {
        node = document.querySelector(selector);
      } catch {
        throw new ContentError('INVALID_ARGS', `Invalid selector: ${selector}`);
      }
      if (node && isVisible(node)) return { found: true, selector };
    }
    if (text) {
      const body = collapse(document.body?.innerText ?? '');
      if (body.includes(text)) return { found: true, text };
    }
    await sleep(100);
  }

  throw new ContentError('TIMEOUT', `Timed out after ${timeout}ms waiting for ${selector ?? `text "${text ?? ''}"`}.`, true);
}

/* -------------------------------------------------------------------------- */
/* Highlight                                                                  */
/* -------------------------------------------------------------------------- */

const HIGHLIGHT_ID = '__celeste_highlight';

function highlightElement(el: HTMLElement): { ref?: string; box: { x: number; y: number; width: number; height: number } } {
  document.getElementById(HIGHLIGHT_ID)?.remove();
  const rect = el.getBoundingClientRect();
  const overlay = document.createElement('div');
  overlay.id = HIGHLIGHT_ID;
  overlay.setAttribute('aria-hidden', 'true');
  overlay.style.position = 'fixed';
  overlay.style.pointerEvents = 'none';
  overlay.style.zIndex = '2147483646';
  overlay.style.border = '2px solid #8b5cf6';
  overlay.style.background = 'rgba(139, 92, 246, 0.18)';
  overlay.style.borderRadius = '4px';
  overlay.style.left = `${rect.left}px`;
  overlay.style.top = `${rect.top}px`;
  overlay.style.width = `${rect.width}px`;
  overlay.style.height = `${rect.height}px`;
  overlay.style.transition = 'all 120ms ease-out';
  (document.body ?? document.documentElement).appendChild(overlay);
  return { box: boxOf(el) };
}

/* -------------------------------------------------------------------------- */
/* Method dispatch                                                            */
/* -------------------------------------------------------------------------- */

async function invoke(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'ping':
      return { ok: true, url: location.href, title: document.title ?? '' };

    case 'snapshot':
      return buildSnapshot({
        maxElements: typeof params['maxElements'] === 'number' ? params['maxElements'] : undefined,
        includeText: params['includeText'] !== false,
      });

    case 'click': {
      const button = (params['button'] as 'left' | 'right' | 'middle' | undefined) ?? 'left';
      const ref = params['ref'] as string | undefined;
      const x = typeof params['x'] === 'number' ? params['x'] : undefined;
      const y = typeof params['y'] === 'number' ? params['y'] : undefined;

      let target: HTMLElement | null = null;
      let usedRef: string | undefined;

      if (ref) {
        target = requireElement(ref, 'click target');
        usedRef = ref;
      } else if (x !== undefined && y !== undefined) {
        const node = document.elementFromPoint(x, y);
        if (!node) throw new ContentError('NOT_FOUND', `No element at (${x}, ${y}).`);
        target = node as HTMLElement;
      } else {
        throw new ContentError('INVALID_ARGS', 'click requires either `ref` or (`x` and `y`).');
      }

      const urlBefore = location.href;
      const point = clickElement(target, button);
      await sleep(30);
      const navigated = location.href !== urlBefore;
      const result: Record<string, unknown> = { ok: true, point };
      if (usedRef) result['ref'] = usedRef;
      if (navigated) {
        result['navigated'] = true;
        result['url'] = location.href;
      }
      return result;
    }

    case 'type': {
      const ref = params['ref'] as string | undefined;
      const text = typeof params['text'] === 'string' ? params['text'] : '';
      const el = requireElement(ref, 'type target');
      const outcome = await typeInto(el, text, {
        clear: params['clear'] === true,
        delayMs: typeof params['delayMs'] === 'number' ? params['delayMs'] : undefined,
      });
      return { ok: true, typed: outcome.typed, ...(ref ? { ref } : {}) };
    }

    case 'fill': {
      const ref = params['ref'] as string | undefined;
      const value = typeof params['value'] === 'string' ? params['value'] : '';
      const el = requireElement(ref, 'fill target');
      fillInto(el, value);
      return { ok: true, typed: value, ...(ref ? { ref } : {}) };
    }

    case 'press': {
      const key = typeof params['key'] === 'string' ? params['key'] : '';
      if (!key) throw new ContentError('INVALID_ARGS', 'press requires `key`.');
      const modifiers = Array.isArray(params['modifiers']) ? (params['modifiers'] as string[]) : [];
      const ref = params['ref'] as string | undefined;
      const el = ref ? requireElement(ref, 'press target') : null;
      if (el) el.focus();
      pressKeyOn(el, key, modifiers);
      await sleep(10);
      return { ok: true, key, modifiers };
    }

    case 'scroll': {
      const direction = (params['direction'] as 'up' | 'down' | 'left' | 'right' | undefined) ?? 'down';
      const amount = typeof params['amount'] === 'number' ? params['amount'] : 400;
      const ref = params['ref'] as string | undefined;
      if (ref) {
        const el = requireElement(ref, 'scroll target');
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
      } else {
        const top = direction === 'down' ? amount : direction === 'up' ? -amount : 0;
        const left = direction === 'right' ? amount : direction === 'left' ? -amount : 0;
        window.scrollBy({ top, left, behavior: 'smooth' });
      }
      await sleep(60);
      return { ok: true, x: Math.round(window.scrollX), y: Math.round(window.scrollY), direction, amount };
    }

    case 'hover': {
      const ref = params['ref'] as string | undefined;
      const el = requireElement(ref, 'hover target');
      const { x, y } = centerOf(el);
      const init = mouseEventInit(x, y, 0, 0);
      el.dispatchEvent(new MouseEvent('mouseover', init));
      el.dispatchEvent(new MouseEvent('mouseenter', init));
      el.dispatchEvent(new MouseEvent('mousemove', init));
      return { ok: true, ref, point: { x, y } };
    }

    case 'select': {
      const ref = params['ref'] as string | undefined;
      const value = typeof params['value'] === 'string' ? params['value'] : '';
      const el = requireElement(ref, 'select target');
      const outcome = selectOption(el, value);
      return { ok: true, ref, selected: outcome.selected };
    }

    case 'focus': {
      const ref = params['ref'] as string | undefined;
      const el = requireElement(ref, 'focus target');
      el.focus();
      return { ok: true, ref, active: document.activeElement === el };
    }

    case 'blur': {
      const ref = params['ref'] as string | undefined;
      const el = ref ? resolveElement(ref) : (document.activeElement as HTMLElement | null);
      if (el) el.blur();
      return { ok: true, ref };
    }

    case 'getText': {
      const selector = params['selector'] as string | undefined;
      if (selector) {
        try {
          const node = document.querySelector(selector);
          if (!node) throw new ContentError('NOT_FOUND', `No element matches "${selector}".`);
          const clone = cleanClone(node);
          return { text: collapse((clone as HTMLElement).innerText ?? clone.textContent ?? '') };
        } catch (err) {
          if (err instanceof ContentError) throw err;
          throw new ContentError('INVALID_ARGS', `Invalid selector: ${selector}`);
        }
      }
      return { text: cleanedText() };
    }

    case 'extract':
      return extractContent(params['selector'] as string | undefined);

    case 'highlight': {
      const ref = params['ref'] as string | undefined;
      const el = requireElement(ref, 'highlight target');
      const outcome = highlightElement(el);
      return { ok: true, ...(ref ? { ref } : {}), ...outcome };
    }

    case 'waitFor':
      return waitForElement({
        selector: params['selector'] as string | undefined,
        text: params['text'] as string | undefined,
        timeoutMs: typeof params['timeoutMs'] === 'number' ? params['timeoutMs'] : undefined,
      });

    case 'challenge':
      return detectChallenge();

    case 'session':
      return detectSessionExpiry();

    default:
      throw new ContentError('INVALID_ARGS', `Unknown content method: ${method}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Messaging                                                                  */
/* -------------------------------------------------------------------------- */

async function handle(request: ContentRequest): Promise<ContentResponse> {
  try {
    const result = await invoke(request.method, request.params ?? {});
    return { channel: CONTENT_CHANNEL, id: request.id, ok: true, result };
  } catch (err) {
    return { channel: CONTENT_CHANNEL, id: request.id, ok: false, error: toErrorShape(err) };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const request = message as ContentRequest | undefined;
  if (!request || request.channel !== CONTENT_CHANNEL) return false;
  void handle(request).then(sendResponse);
  return true;
});

/* -------------------------------------------------------------------------- */
/* Global bridge                                                              */
/* -------------------------------------------------------------------------- */

interface CelesteBridge {
  version: string;
  invoke: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
}

const bridge: CelesteBridge = {
  version: '0.1.0',
  invoke: async (method: string, params?: Record<string, unknown>) => {
    const response = await handle({ channel: CONTENT_CHANNEL, id: `direct-${Date.now()}`, method, params });
    if (!response.ok) throw new ContentError(response.error?.code ?? 'INTERNAL', response.error?.message ?? 'Content error');
    return response.result;
  },
};

(window as unknown as { __celeste?: CelesteBridge }).__celeste = bridge;

/* -------------------------------------------------------------------------- */
/* Page hook synchronisation (network + console)                              */
/* -------------------------------------------------------------------------- */

const PAGE_SOURCE = 'celeste-page';
const CELESTE_SOURCE = 'celeste';

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data as { source?: string; type?: string; payload?: unknown } | undefined;
  if (!data || data.source !== PAGE_SOURCE) return;

  if (data.type === 'network') {
    void sendRuntimeMessage({ type: 'celeste:event', event: { type: 'network.captured', payload: data.payload, timestamp: Date.now() } });
  } else if (data.type === 'console') {
    void sendRuntimeMessage({ type: 'celeste:event', event: { type: 'console.message', payload: data.payload, timestamp: Date.now() } });
  } else if (data.type === 'sync-response') {
    const payload = data.payload as { network?: unknown[]; console?: unknown[] } | undefined;
    for (const entry of payload?.network ?? []) {
      void sendRuntimeMessage({ type: 'celeste:event', event: { type: 'network.captured', payload: entry, timestamp: Date.now() } });
    }
    for (const entry of payload?.console ?? []) {
      void sendRuntimeMessage({ type: 'celeste:event', event: { type: 'console.message', payload: entry, timestamp: Date.now() } });
    }
  }
});

async function sendRuntimeMessage(message: unknown): Promise<void> {
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    /* the service worker may be restarting — the event is best effort */
  }
}

function requestPageSync(): void {
  window.postMessage({ source: CELESTE_SOURCE, type: 'sync-request' }, '*');
}

/* -------------------------------------------------------------------------- */
/* Mutation observer                                                          */
/* -------------------------------------------------------------------------- */

const MUTATION_THROTTLE_MS = 500;
let lastMutationAt = 0;
let mutationTimer: ReturnType<typeof setTimeout> | null = null;

function flushMutation(): void {
  mutationTimer = null;
  lastMutationAt = Date.now();
  void sendRuntimeMessage({
    type: 'celeste:event',
    event: { type: 'dom.mutated', payload: { url: location.href, at: lastMutationAt }, timestamp: Date.now() },
  });
}

function startMutationObserver(): void {
  const target = document.body ?? document.documentElement;
  if (!target) return;
  const observer = new MutationObserver(() => {
    const now = Date.now();
    if (now - lastMutationAt >= MUTATION_THROTTLE_MS) {
      flushMutation();
      return;
    }
    if (mutationTimer === null) {
      mutationTimer = setTimeout(flushMutation, MUTATION_THROTTLE_MS - (now - lastMutationAt));
    }
  });
  observer.observe(target, { childList: true, subtree: true, attributes: true, characterData: false });
}

function startSessionWatcher(): void {
  const check = (): void => {
    const result = detectSessionExpiry();
    if (result.expired) {
      void sendRuntimeMessage({
        type: 'celeste:event',
        event: { type: 'session.expired', payload: { url: location.href, reason: result.reason }, timestamp: Date.now() },
      });
    }
  };
  check();
  setInterval(check, 5000);
}

function bootstrap(): void {
  startMutationObserver();
  startSessionWatcher();
  requestPageSync();
  // If the MAIN-world hook is missing (page loaded before the extension), ask
  // the background worker to inject it.
  window.setTimeout(() => {
    void chrome.runtime
      .sendMessage({ type: 'celeste:ensure-hook' })
      .then((response: unknown) => {
        const result = response as { ok?: boolean } | undefined;
        if (result?.ok) requestPageSync();
      })
      .catch(() => undefined);
  }, 500);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
} else {
  bootstrap();
}
