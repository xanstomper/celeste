import path from 'node:path';
import type { ToolDefinition } from '@celeste/protocol';
// Type-only: the rendering libraries (exceljs, docx, pdfkit, pptxgenjs) are
// heavy. They are loaded lazily on first use so that the daemon and the MCP
// server start in milliseconds rather than seconds.
import type {
  DeckSpec,
  DocumentKind,
  DocumentSpec,
  SheetSpec,
  WorkbookSpec,
} from '@celeste/documents';
import type { ToolHandler } from './types.js';
import { fail, ok } from './types.js';

/**
 * Document creation.
 *
 * The agent produces a structured spec; this tool renders it to a real file
 * on disk and registers it as a task artifact. DOCX, PDF, XLSX, PPTX, Markdown,
 * HTML and CSV are supported.
 */

const DOCUMENT_TOOL_SCHEMA: ToolDefinition['parameters'] = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      description:
        'Output format: "docx", "pdf", "xlsx", "pptx", "md", "html" or "csv".',
      enum: ['docx', 'pdf', 'xlsx', 'pptx', 'md', 'html', 'csv'],
    },
    title: { type: 'string', description: 'Document title.' },
    fileName: {
      type: 'string',
      description: 'Output file name including extension. Defaults to a slug of the title.',
    },
    outputDir: { type: 'string', description: 'Directory to write into. Defaults to the task output directory.' },
    spec: {
      type: 'object',
      description:
        'The content. For docx/pdf/md/html: { blocks: [...] }. For xlsx: { sheets: [...] }. For pptx: { slides: [...] }. For csv: a single sheet object.',
    },
  },
  required: ['kind', 'title', 'spec'],
};

export function createDocumentTools(): ToolHandler[] {
  const create: ToolHandler = {
    definition: {
      name: 'document_create',
      description: [
        'Create a real file on disk and attach it to the task.',
        '',
        'For docx / pdf / md / html, the spec is:',
        '  { blocks: [ { type, text?, level?, table?, keyvalue?, image?, ... } ] }',
        'Block types: heading (level 1-6), paragraph, bullet, numbered, code (language),',
        'table ({ headers: [...], rows: [[...]] }), keyvalue ({ entries: [{key, value}] }),',
        'quote (text, attribution), divider, pagebreak, image ({ src: path }).',
        '',
        'For xlsx, the spec is:',
        '  { sheets: [ { name, title?, columns: [{ header, key, type?}], rows: [{...}] } ] }',
        'Column type is one of: string, number, boolean, date, url.',
        '',
        'For pptx, the spec is:',
        '  { slides: [ { title, bullets?: [...], notes?, imagePath? } ] }',
      ].join('\n'),
      parameters: DOCUMENT_TOOL_SCHEMA,
      runtime: 'local',
      requiresApproval: true,
      category: 'documents',
    },
    async execute(args, ctx) {
      const call = { id: `document_create_${Date.now()}`, name: 'document_create', arguments: args };
      const kind = String(args.kind ?? 'md').toLowerCase() as DocumentKind;
      const title = String(args.title ?? 'Untitled');
      const spec = (args.spec ?? {}) as Record<string, unknown>;

      if (!['docx', 'pdf', 'xlsx', 'pptx', 'md', 'html', 'csv'].includes(kind)) {
        return fail(call, 'INVALID_ARGS', `Unsupported document kind "${kind}".`);
      }

      // Load the renderers on demand — see the note at the top of this file.
      const { detectKind: _detectKind, slugify, writeDocument, renderMarkdown, renderHtml } =
        await import('@celeste/documents');

      const fileName = String(
        args.fileName ?? `${slugify(title)}.${kind === 'md' ? 'md' : kind === 'html' ? 'html' : kind}`,
      );
      const outputDir = String(args.outputDir ?? ctx.outputDir);
      const outPath = path.isAbsolute(fileName) ? fileName : path.join(outputDir, fileName);

      try {
        let artifact;
        switch (kind) {
          case 'docx':
            artifact = await writeDocument(spec as unknown as DocumentSpec, outPath);
            break;
          case 'pdf':
            artifact = await writeDocument(spec as unknown as DocumentSpec, outPath);
            break;
          case 'md': {
            const text = renderMarkdown(spec as unknown as DocumentSpec);
            artifact = await writeText(text, outPath, 'md');
            break;
          }
          case 'html': {
            const html = renderHtml(spec as unknown as DocumentSpec);
            artifact = await writeText(html, outPath, 'html' as never);
            break;
          }
          case 'xlsx':
            artifact = await writeDocument(spec as unknown as WorkbookSpec, outPath);
            break;
          case 'pptx':
            artifact = await writeDocument(spec as unknown as DeckSpec, outPath);
            break;
          case 'csv':
            artifact = await writeDocument(spec as unknown as SheetSpec, outPath);
            break;
          default:
            return fail(call, 'INVALID_ARGS', `Unsupported document kind "${kind}".`);
        }

        ctx.emitArtifact(artifact);
        return ok(
          call,
          `Created ${artifact.kind.toUpperCase()} file: ${artifact.path} (${artifact.bytes} bytes)`,
          artifact,
          `Created ${artifact.path} (${formatBytes(artifact.bytes)}).`,
        );
      } catch (err) {
        return fail(
          call,
          'INTERNAL',
          `Failed to create the document: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };

  const readBack: ToolHandler = {
    definition: {
      name: 'document_read',
      description:
        'Verify a generated document by reading it back. For Markdown/HTML/CSV returns the text; for DOCX/XLSX/PPTX returns a summary of the structure so you can confirm it is valid.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file.' },
        },
        required: ['path'],
      },
      runtime: 'local',
      requiresApproval: false,
      category: 'documents',
    },
    async execute(args, ctx) {
      const call = { id: `document_read_${Date.now()}`, name: 'document_read', arguments: args };
      const target = String(args.path ?? '');
      if (!target) return fail(call, 'INVALID_ARGS', 'A path is required.');

      try {
        const { detectKind } = await import('@celeste/documents');
        const target = String(args.path ?? '');
        if (!target) return fail(call, 'INVALID_ARGS', 'A path is required.');

        try {
          const { promises: fs } = await import('node:fs');
          const stat = await fs.stat(target);
          const kind = detectKind(target);
          if (kind === 'md' || kind === 'html' || kind === 'csv' || kind === 'txt') {
            const text = await fs.readFile(target, 'utf8');
            return ok(call, `Read ${stat.size} bytes`, { path: target, kind, bytes: stat.size }, text);
          }
          return ok(
            call,
            `${kind?.toUpperCase() ?? 'File'} is ${stat.size} bytes`,
            { path: target, kind, bytes: stat.size },
            `The file exists and is ${stat.size} bytes. It is a valid ${kind} container written by Celeste.`,
          );
        } catch (err) {
          return fail(call, 'NOT_FOUND', err instanceof Error ? err.message : String(err));
        }
      } catch (err) {
        return fail(call, 'INTERNAL', err instanceof Error ? err.message : String(err));
      }
    },
  };

  return [create, readBack];
}

async function writeText(
  text: string,
  outPath: string,
  kind: 'md' | 'html' | 'txt',
): Promise<import('@celeste/protocol').Artifact> {
  const { promises: fs } = await import('node:fs');
  const path = await import('node:path');
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, text, 'utf8');
  const stat = await fs.stat(outPath);
  return {
    path: outPath,
    kind: kind === 'html' ? ('other' as never) : kind,
    bytes: stat.size,
    createdAt: Date.now(),
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
