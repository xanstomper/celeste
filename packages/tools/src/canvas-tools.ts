import type {
  CanvasBlock,
  CanvasFile,
  CanvasKind,
  CanvasSpec,
  CanvasState,
  ToolDefinition,
} from '@celeste/protocol';

import type { ToolHandler } from './types.js';

const KINDS: readonly CanvasKind[] = ['document', 'visual', 'image', 'project'];

const CANVAS_PARAMETERS = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: [...KINDS],
      description:
        'document = Markdown report; visual = a designed board (use `spec`) or a complete self-contained HTML page; image = a generated or attached image URL; project = a small file tree.',
    },
    title: {
      type: 'string',
      description: 'Short title shown on the canvas tab, e.g. "Microplastics evidence map".',
    },
    content: {
      type: 'string',
      description:
        'Markdown for a document, complete HTML for a visual (inline CSS/JS only, no external files), an image URL for an image. Leave empty for a project or when `spec` is used.',
    },
    spec: {
      type: 'object',
      description:
        'A visual canvas described as blocks. The panel draws these itself - real cards, real charts, real type - so prefer this over raw HTML for a visual canvas.',
      properties: {
        eyebrow: { type: 'string', description: 'Small label above the title, e.g. "Q3 review".' },
        title: { type: 'string' },
        subtitle: { type: 'string' },
        theme: { type: 'string', enum: ['light', 'dark'] },
        blocks: {
          type: 'array',
          description: 'The board, top to bottom.',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: [
                  'heading',
                  'text',
                  'kpi',
                  'chart',
                  'table',
                  'image',
                  'list',
                  'quote',
                  'code',
                  'divider',
                  'spacer',
                ],
              },
              text: { type: 'string', description: 'heading, text, quote' },
              level: { type: 'number', description: 'heading level: 1, 2 or 3' },
              tone: { type: 'string', enum: ['default', 'muted', 'lead'], description: 'text' },
              label: { type: 'string', description: 'kpi: what is measured' },
              value: { type: 'string', description: 'kpi: the number, formatted' },
              delta: { type: 'string', description: 'kpi: change, e.g. "+12%"' },
              trend: { type: 'string', enum: ['up', 'down', 'flat'], description: 'kpi' },
              chart: { type: 'string', enum: ['bar', 'line', 'donut'] },
              labels: { type: 'array', items: { type: 'string' } },
              values: { type: 'array', items: { type: 'number' } },
              unit: { type: 'string', description: 'chart unit, e.g. "M" or "%"' },
              columns: { type: 'array', items: { type: 'string' } },
              rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
              url: { type: 'string', description: 'image source' },
              caption: { type: 'string' },
              alt: { type: 'string' },
              items: { type: 'array', items: { type: 'string' }, description: 'list' },
              ordered: { type: 'boolean', description: 'list' },
              cite: { type: 'string', description: 'quote attribution' },
              language: { type: 'string', description: 'code' },
              code: { type: 'string', description: 'code' },
              size: { type: 'string', enum: ['sm', 'md', 'lg'], description: 'spacer' },
            },
            required: ['type'],
          },
        },
      },
      required: ['blocks'],
    },
    files: {
      type: 'array',
      description: 'Files for a project canvas. Ignored for other kinds.',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path, e.g. src/index.ts' },
          content: { type: 'string' },
          language: { type: 'string', description: 'Optional syntax hint, e.g. ts, css, md' },
        },
        required: ['path', 'content'],
      },
    },
  },
  required: ['kind', 'title'],
  additionalProperties: false,
};

/**
 * Turns whatever the model sent into a clean canvas spec.
 *
 * Models are generous with types: a number where a string belongs, an
 * unknown block type, a missing label. The board must still render, so
 * everything is coerced and anything unusable is dropped.
 */
function normalizeSpec(raw: unknown): CanvasSpec | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const source = raw as Record<string, unknown>;
  const blocks = Array.isArray(source['blocks']) ? source['blocks'] : undefined;
  if (!blocks) return undefined;

  const text = (value: unknown, max = 4000): string =>
    typeof value === 'string' ? value.slice(0, max) : value === undefined || value === null ? '' : String(value).slice(0, max);

  const strings = (value: unknown, max = 40): string[] =>
    Array.isArray(value) ? value.slice(0, max).map((item) => text(item, 200)) : [];

  const numbers = (value: unknown, max = 40): number[] =>
    Array.isArray(value)
      ? value.slice(0, max).map((item) => (typeof item === 'number' ? item : Number(item) || 0))
      : [];

  const rows = (value: unknown): string[][] =>
    Array.isArray(value)
      ? value.slice(0, 200).map((row) => (Array.isArray(row) ? row.map((cell) => text(cell, 300)) : []))
      : [];

  const known = new Set([
    'heading',
    'text',
    'kpi',
    'chart',
    'table',
    'image',
    'list',
    'quote',
    'code',
    'divider',
    'spacer',
  ]);

  const normalised: CanvasBlock[] = [];
  for (const item of blocks.slice(0, 200)) {
    if (!item || typeof item !== 'object') continue;
    const block = item as Record<string, unknown>;
    const type = String(block['type'] ?? '');
    if (!known.has(type)) continue;
    const title = text(block['title'], 300);
    const unit = text(block['unit'], 16);

    switch (type) {
      case 'heading':
        normalised.push({
          type: 'heading',
          text: text(block['text'], 600),
          level: (block['level'] === 2 || block['level'] === 3 ? block['level'] : 1) as 1 | 2 | 3,
        });
        break;
      case 'text':
        normalised.push({
          type: 'text',
          text: text(block['text']),
          tone:
            block['tone'] === 'muted' || block['tone'] === 'lead'
              ? (block['tone'] as 'muted' | 'lead')
              : 'default',
        });
        break;
      case 'kpi':
        normalised.push({
          type: 'kpi',
          label: text(block['label'], 120),
          value: text(block['value'], 60),
          ...(text(block['delta'], 40) ? { delta: text(block['delta'], 40) } : {}),
          trend:
            block['trend'] === 'up' || block['trend'] === 'down' || block['trend'] === 'flat'
              ? (block['trend'] as 'up' | 'down' | 'flat')
              : 'flat',
        });
        break;
      case 'chart': {
        const chart = block['chart'];
        if (chart !== 'bar' && chart !== 'line' && chart !== 'donut') break;
        const labels = strings(block['labels']);
        const values = numbers(block['values']);
        if (labels.length === 0 || values.length === 0) break;
        normalised.push({
          type: 'chart',
          chart,
          title,
          labels,
          values: values.slice(0, labels.length),
          ...(unit ? { unit } : {}),
        });
        break;
      }
      case 'table': {
        const columns = strings(block['columns'], 20);
        const tableRows = rows(block['rows']);
        if (columns.length === 0) break;
        normalised.push({ type: 'table', title, columns, rows: tableRows });
        break;
      }
      case 'image': {
        const url = text(block['url'], 2000);
        if (!url) break;
        normalised.push({
          type: 'image',
          url,
          ...(text(block['caption'], 300) ? { caption: text(block['caption'], 300) } : {}),
          ...(text(block['alt'], 300) ? { alt: text(block['alt'], 300) } : {}),
        });
        break;
      }
      case 'list': {
        const items = strings(block['items'], 60);
        if (items.length === 0) break;
        normalised.push({
          type: 'list',
          title,
          items,
          ...(block['ordered'] === true ? { ordered: true } : {}),
        });
        break;
      }
      case 'quote':
        normalised.push({
          type: 'quote',
          text: text(block['text'], 2000),
          ...(text(block['cite'], 200) ? { cite: text(block['cite'], 200) } : {}),
        });
        break;
      case 'code':
        normalised.push({
          type: 'code',
          code: text(block['code'], 8000),
          ...(text(block['language'], 24) ? { language: text(block['language'], 24) } : {}),
        });
        break;
      case 'divider':
        normalised.push({ type: 'divider' });
        break;
      case 'spacer':
        normalised.push({
          type: 'spacer',
          size:
            block['size'] === 'sm' || block['size'] === 'lg'
              ? (block['size'] as 'sm' | 'lg')
              : 'md',
        });
        break;
      default:
        break;
    }
  }

  if (normalised.length === 0) return undefined;

  return {
    ...(text(source['eyebrow'], 120) ? { eyebrow: text(source['eyebrow'], 120) } : {}),
    ...(text(source['title'], 200) ? { title: text(source['title'], 200) } : {}),
    ...(text(source['subtitle'], 400) ? { subtitle: text(source['subtitle'], 400) } : {}),
    ...(source['theme'] === 'dark' ? { theme: 'dark' as const } : {}),
    blocks: normalised,
  };
}

/**
 * Tools that build the canvas beside the conversation.
 *
 * The canvas is one workspace per task, replaced each time the agent writes
 * to it. That is deliberate: a task is a train of thought, and a second
 * canvas would be a second train.
 */
export function createCanvasTools(
  options: { imageBaseUrl?: string } = {},
): ToolHandler[] {
  const imageBase = options.imageBaseUrl ?? 'https://image.pollinations.ai/prompt';

  const write: ToolHandler = {
    definition: {
      name: 'canvas_write',
      description:
        'Create or replace the task canvas — a workspace shown beside the chat. Use it for reports, dashboards, diagrams, charts, small apps and project scaffolds. For a visual canvas, describe it with `spec` (blocks the panel draws natively); a complete HTML document in `content` also works. The user can see the canvas immediately; keep chat answers short when the canvas carries the detail.',
      parameters: CANVAS_PARAMETERS as unknown as ToolDefinition['parameters'],
      runtime: 'local',
      requiresApproval: false,
      category: 'canvas',
    },
    async execute(args, ctx) {
      const kind = String(args.kind ?? '') as CanvasKind;
      if (!KINDS.includes(kind)) {
        return {
          ok: false,
          summary: 'Invalid canvas kind',
          error: {
            code: 'INVALID_ARGS' as const,
            message: `kind must be one of ${KINDS.join(', ')}.`,
            retryable: false,
          },
        };
      }

      const title = String(args.title ?? 'Canvas').trim().slice(0, 120) || 'Canvas';
      const content = typeof args.content === 'string' ? args.content : '';

      // A visual canvas may arrive as a structured board. The panel draws
      // that itself, which is why it looks the same everywhere and can be
      // edited block by block.
      const spec = normalizeSpec(args.spec);
      const canvasContent = spec ? JSON.stringify(spec) : content;

      const rawFiles = Array.isArray(args.files) ? args.files : [];
      const files: CanvasFile[] = rawFiles
        .filter(
          (file): file is Record<string, unknown> =>
            Boolean(file) && typeof file === 'object' && typeof (file as CanvasFile).path === 'string',
        )
        .map((file) => ({
          path: String(file.path).slice(0, 200),
          content: String(file.content ?? ''),
          ...(typeof file.language === 'string' ? { language: file.language } : {}),
        }))
        .slice(0, 40);

      if (kind === 'project' && files.length === 0) {
        return {
          ok: false,
          summary: 'Project canvas needs files',
          error: {
            code: 'INVALID_ARGS' as const,
            message: 'A project canvas needs at least one file in `files`.',
            retryable: false,
          },
        };
      }
      if (kind !== 'project' && content.trim().length === 0 && !spec) {
        return {
          ok: false,
          summary: 'Canvas content is empty',
          error: {
            code: 'INVALID_ARGS' as const,
            message: `A ${kind} canvas needs non-empty content.`,
            retryable: false,
          },
        };
      }

      const canvas: CanvasState = {
        id: `canvas_${ctx.taskId}`,
        kind,
        title,
        content: canvasContent,
        ...(spec ? { spec } : {}),
        ...(files.length > 0 ? { files } : {}),
        updatedAt: Date.now(),
      };

      ctx.store.setCanvas?.(ctx.taskId, canvas);
      ctx.bus.publish({ type: 'task.canvas', taskId: ctx.taskId, canvas, at: Date.now() });

      return {
        ok: true,
        summary: `Canvas ready — ${title}`,
        data: { kind, title, files: files.length, blocks: spec?.blocks.length ?? 0 },
        text:
          `The ${kind} canvas "${title}" is now open beside the conversation. ` +
          'Do not repeat its contents in the chat; summarise what it shows in one or two sentences.',
      };
    },
  };

  const image: ToolHandler = {
    definition: {
      name: 'generate_image',
      description:
        'Generate an image from a text prompt and show it in the image canvas. Use this when the user asks for a picture, illustration, diagram-as-image, logo concept or photo. Describe the subject, style, lighting and composition in the prompt.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'A vivid, specific image prompt.' },
          width: { type: 'number', description: 'Pixels, 256-1536. Default 1024.' },
          height: { type: 'number', description: 'Pixels, 256-1536. Default 1024.' },
        },
        required: ['prompt'],
        additionalProperties: false,
      } as ToolDefinition['parameters'],
      runtime: 'local',
      requiresApproval: false,
      category: 'canvas',
    },
    async execute(args, ctx) {
      const prompt = String(args.prompt ?? '').trim();
      if (!prompt) {
        return {
          ok: false,
          summary: 'Image prompt is required',
          error: {
            code: 'INVALID_ARGS' as const,
            message: 'A prompt is required to generate an image.',
            retryable: false,
          },
        };
      }

      const clamp = (value: unknown, fallback: number) => {
        const number = Number(value);
        if (!Number.isFinite(number)) return fallback;
        return Math.min(1536, Math.max(256, Math.round(number)));
      };
      const width = clamp(args.width, 1024);
      const height = clamp(args.height, 1024);
      const seed = Math.floor(Math.random() * 1_000_000_000);
      const url =
        `${imageBase}/${encodeURIComponent(prompt)}` +
        `?width=${width}&height=${height}&seed=${seed}&nologo=true`;

      const title = prompt.length > 70 ? `${prompt.slice(0, 67)}…` : prompt;
      const canvas: CanvasState = {
        id: `canvas_${ctx.taskId}`,
        kind: 'image',
        title,
        content: url,
        updatedAt: Date.now(),
      };

      ctx.store.setCanvas?.(ctx.taskId, canvas);
      ctx.bus.publish({ type: 'task.canvas', taskId: ctx.taskId, canvas, at: Date.now() });

      return {
        ok: true,
        summary: `Image generating — ${title}`,
        data: { url, width, height, prompt },
        text:
          'The image is generating in the image canvas (it may take a few seconds to appear). ' +
          'Tell the user what it depicts in one sentence; do not paste the URL into the answer.',
      };
    },
  };

  return [write, image];
}
