import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ToolDefinition } from '@celeste/protocol';
import type { ToolContext, ToolHandler } from './types.js';
import { fail, ok } from './types.js';

/**
 * Filesystem tools.
 *
 * Every path is resolved and checked against the allowed roots before it is
 * touched, so the agent cannot wander outside the user's workspace by
 * accident (or by being talked into it by a hostile page).
 */

export interface FileToolOptions {
  /** Directories the agent may read and write in. */
  allowedRoots: string[];
  /** Maximum bytes a single read may return. */
  maxReadBytes?: number;
}

const MAX_READ_BYTES = 2 * 1024 * 1024;

function def(
  name: string,
  description: string,
  parameters: ToolDefinition['parameters'],
  requiresApproval = false,
): ToolDefinition {
  return {
    name,
    description,
    parameters,
    runtime: 'local',
    requiresApproval,
    category: 'files',
  };
}

/** Resolves a path and verifies it is inside one of the allowed roots. */
export function resolveInside(paths: string[], candidate: string, roots: string[]): string {
  const resolved = path.resolve(candidate);
  const rootsResolved = roots.map((r) => path.resolve(r));
  const inside = rootsResolved.some(
    (root) => resolved === root || resolved.startsWith(root + path.sep),
  );
  if (!inside) {
    throw new Error(
      `Path "${candidate}" is outside the allowed directories (${rootsResolved.join(', ')}).`,
    );
  }
  return resolved;
}

export function createFileTools(options: FileToolOptions): ToolHandler[] {
  const maxRead = options.maxReadBytes ?? MAX_READ_BYTES;

  const roots = (ctx: ToolContext): string[] => {
    const list = [...options.allowedRoots];
    if (ctx.outputDir) list.push(ctx.outputDir);
    return list.filter(Boolean);
  };

  const read: ToolHandler = {
    definition: def(
      'file_read',
      'Read a UTF-8 text file from disk. Returns the file contents with a line-numbered prefix for easier reference.',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative path to the file.' },
          maxLines: {
            type: 'integer',
            description: 'Maximum number of lines to return. Default 2000.',
            default: 2000,
          },
        },
        required: ['path'],
      },
    ),
    async execute(args, ctx) {
      const call = { id: `file_read_${Date.now()}`, name: 'file_read', arguments: args };
      try {
        const target = resolveInside([], String(args.path), roots(ctx));
        const stat = await fs.stat(target);
        if (stat.isDirectory()) {
          return fail(call, 'INVALID_ARGS', `"${args.path}" is a directory. Use file_list.`);
        }
        if (stat.size > maxRead) {
          const handle = await fs.open(target, 'r');
          try {
            const buf = Buffer.alloc(maxRead);
            await handle.read(buf, 0, maxRead, 0);
            const text = buf.toString('utf8');
            return ok(
              call,
              `Read first ${maxRead} bytes of ${stat.size}`,
              { path: target, truncated: true, bytes: stat.size },
              numberLines(text),
            );
          } finally {
            await handle.close();
          }
        }
        const text = await fs.readFile(target, 'utf8');
        const maxLines = Number(args.maxLines ?? 2000);
        const lines = text.split('\n');
        const sliced = lines.slice(0, maxLines).join('\n');
        return ok(
          call,
          `Read ${stat.size} bytes from ${path.basename(target)}`,
          { path: target, bytes: stat.size, lines: lines.length, truncated: lines.length > maxLines },
          numberLines(sliced),
        );
      } catch (err) {
        return fail(call, 'NOT_FOUND', err instanceof Error ? err.message : String(err));
      }
    },
  };

  const write: ToolHandler = {
    definition: def(
      'file_write',
      'Write text to a file on disk, creating parent directories as needed. Overwrites an existing file unless append is true.',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to write to.' },
          content: { type: 'string', description: 'The full file contents.' },
          append: { type: 'boolean', description: 'Append instead of overwriting.', default: false },
        },
        required: ['path', 'content'],
      },
      true,
    ),
    async execute(args, ctx) {
      const call = { id: `file_write_${Date.now()}`, name: 'file_write', arguments: args };
      try {
        const target = resolveInside([], String(args.path), roots(ctx));
        await fs.mkdir(path.dirname(target), { recursive: true });
        const content = String(args.content);
        if (args.append) {
          await fs.appendFile(target, content, 'utf8');
        } else {
          await fs.writeFile(target, content, 'utf8');
        }
        const stat = await fs.stat(target);
        ctx.emitArtifact({
          path: target,
          kind: target.endsWith('.md') ? 'md' : target.endsWith('.json') ? 'json' : 'txt',
          bytes: stat.size,
          createdAt: Date.now(),
          description: 'Text file',
        });
        return ok(call, `Wrote ${stat.size} bytes to ${target}`, { path: target, bytes: stat.size });
      } catch (err) {
        return fail(call, 'PERMISSION_DENIED', err instanceof Error ? err.message : String(err));
      }
    },
  };

  const list: ToolHandler = {
    definition: def(
      'file_list',
      'List the files and directories inside a directory.',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory to list. Defaults to the output directory.' },
          recursive: { type: 'boolean', description: 'Recurse into subdirectories.', default: false },
        },
      },
    ),
    async execute(args, ctx) {
      const call = { id: `file_list_${Date.now()}`, name: 'file_list', arguments: args };
      try {
        const target = resolveInside(
          [],
          String(args.path ?? ctx.outputDir),
          roots(ctx),
        );
        const stat = await fs.stat(target);
        if (!stat.isDirectory()) {
          return fail(call, 'INVALID_ARGS', `"${args.path}" is not a directory.`);
        }
        const entries = await fs.readdir(target, { withFileTypes: true });
        const lines: string[] = [];
        for (const entry of entries) {
          if (entry.name.startsWith('.') && entry.name !== '.') continue;
          let size = '';
          if (entry.isFile()) {
            try {
              size = ` (${(await fs.stat(path.join(target, entry.name))).size} bytes)`;
            } catch {
              size = '';
            }
          }
          lines.push(`${entry.isDirectory() ? 'd' : '-'} ${entry.name}${size}`);
        }
        return ok(
          call,
          `${entries.length} entries in ${target}`,
          { path: target, entries: entries.map((e) => e.name) },
          lines.join('\n') || '(empty directory)',
        );
      } catch (err) {
        return fail(call, 'NOT_FOUND', err instanceof Error ? err.message : String(err));
      }
    },
  };

  const remove: ToolHandler = {
    definition: def(
      'file_delete',
      'Delete a file or directory from disk.',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to delete.' },
          recursive: { type: 'boolean', description: 'Required to delete a non-empty directory.' },
        },
        required: ['path'],
      },
      true,
    ),
    async execute(args, ctx) {
      const call = { id: `file_delete_${Date.now()}`, name: 'file_delete', arguments: args };
      try {
        const target = resolveInside([], String(args.path), roots(ctx));
        await fs.rm(target, { recursive: Boolean(args.recursive), force: false });
        return ok(call, `Deleted ${target}`, { path: target });
      } catch (err) {
        return fail(call, 'PERMISSION_DENIED', err instanceof Error ? err.message : String(err));
      }
    },
  };

  const move: ToolHandler = {
    definition: def(
      'file_move',
      'Move or rename a file or directory.',
      {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Source path.' },
          to: { type: 'string', description: 'Destination path.' },
        },
        required: ['from', 'to'],
      },
      true,
    ),
    async execute(args, ctx) {
      const call = { id: `file_move_${Date.now()}`, name: 'file_move', arguments: args };
      try {
        const from = resolveInside([], String(args.from), roots(ctx));
        const to = resolveInside([], String(args.to), roots(ctx));
        await fs.mkdir(path.dirname(to), { recursive: true });
        await fs.rename(from, to);
        return ok(call, `Moved ${from} to ${to}`, { from, to });
      } catch (err) {
        return fail(call, 'PERMISSION_DENIED', err instanceof Error ? err.message : String(err));
      }
    },
  };

  const search: ToolHandler = {
    definition: def(
      'file_search',
      'Find files by name or by content across the allowed directories.',
      {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Substring to look for in file names.' },
          content: { type: 'string', description: 'Substring to look for inside files.' },
          path: { type: 'string', description: 'Directory to search in.' },
          limit: { type: 'integer', description: 'Maximum matches. Default 50.', default: 50 },
        },
        required: ['path'],
      },
    ),
    async execute(args, ctx) {
      const call = { id: `file_search_${Date.now()}`, name: 'file_search', arguments: args };
      try {
        const root = resolveInside([], String(args.path), roots(ctx));
        const limit = Number(args.limit ?? 50);
        const nameQuery = args.query ? String(args.query).toLowerCase() : null;
        const contentQuery = args.content ? String(args.content) : null;
        const matches: string[] = [];

        const walk = async (dir: string, depth: number): Promise<void> => {
          if (matches.length >= limit || depth > 6) return;
          let entries;
          try {
            entries = await fs.readdir(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const entry of entries) {
            if (matches.length >= limit) return;
            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              await walk(full, depth + 1);
              continue;
            }
            if (nameQuery && !entry.name.toLowerCase().includes(nameQuery)) continue;
            if (contentQuery) {
              try {
                const text = await fs.readFile(full, 'utf8');
                if (!text.includes(contentQuery)) continue;
              } catch {
                continue;
              }
            }
            matches.push(full);
          }
        };

        await walk(root, 0);
        return ok(
          call,
          `${matches.length} matches`,
          { path: root, matches },
          matches.join('\n') || '(no matches)',
        );
      } catch (err) {
        return fail(call, 'NOT_FOUND', err instanceof Error ? err.message : String(err));
      }
    },
  };

  return [read, write, list, remove, move, search];
}

/** Prefixes each line with its 1-based number for easier citation. */
export function numberLines(text: string): string {
  return text
    .split('\n')
    .map((line, i) => `${i + 1}: ${line}`)
    .join('\n');
}
