import type { CanvasFile, CanvasKind, CanvasState, ToolDefinition } from '@celeste/protocol';

import type { ToolHandler } from './types.js';

const KINDS: readonly CanvasKind[] = ['document', 'visual', 'image', 'project'];

const CANVAS_PARAMETERS = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: [...KINDS],
      description:
        'document = Markdown report; visual = a complete self-contained HTML page (charts, dashboards, diagrams, small apps); image = a generated or attached image URL; project = a small file tree.',
    },
    title: {
      type: 'string',
      description: 'Short title shown on the canvas tab, e.g. "Microplastics evidence map".',
    },
    content: {
      type: 'string',
      description:
        'Markdown for a document, complete HTML for a visual (inline CSS/JS only, no external files), an image URL for an image. Leave empty for a project.',
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
        'Create or replace the task canvas — a workspace shown beside the chat. Use it for reports, dashboards, diagrams, charts, small apps and project scaffolds. Visual canvases must be one complete HTML document with inline CSS and JS. The user can see the canvas immediately; keep chat answers short when the canvas carries the detail.',
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
      if (kind !== 'project' && content.trim().length === 0) {
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
        content,
        ...(files.length > 0 ? { files } : {}),
        updatedAt: Date.now(),
      };

      ctx.store.setCanvas?.(ctx.taskId, canvas);
      ctx.bus.publish({ type: 'task.canvas', taskId: ctx.taskId, canvas, at: Date.now() });

      return {
        ok: true,
        summary: `Canvas ready — ${title}`,
        data: { kind, title, files: files.length },
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
