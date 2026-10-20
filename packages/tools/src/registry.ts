import type { ToolCall, ToolDefinition, ToolResult } from '@celeste/protocol';
import { CelesteError } from '@celeste/protocol';
import type { ToolContext, ToolHandler } from './types.js';

/**
 * The tool registry.
 *
 * Every capability the agent has is a `ToolHandler` registered here. The
 * registry validates arguments before execution, so a hallucinated or
 * malformed call produces a clean error instead of an exception.
 */
export class ToolRegistry {
  private readonly handlers = new Map<string, ToolHandler>();

  register(handler: ToolHandler): this {
    if (this.handlers.has(handler.definition.name)) {
      throw new Error(`Tool "${handler.definition.name}" is already registered`);
    }
    this.handlers.set(handler.definition.name, handler);
    return this;
  }

  registerAll(handlers: ToolHandler[]): this {
    for (const handler of handlers) this.register(handler);
    return this;
  }

  get(name: string): ToolHandler | undefined {
    return this.handlers.get(name);
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  /** All tool definitions, ready to be handed to a model. */
  list(): ToolDefinition[] {
    return [...this.handlers.values()].map((h) => h.definition);
  }

  /** Definitions grouped by category — used by the UI. */
  listByCategory(): Record<string, ToolDefinition[]> {
    const groups: Record<string, ToolDefinition[]> = {};
    for (const handler of this.handlers.values()) {
      const category = handler.definition.category ?? 'general';
      (groups[category] ??= []).push(handler.definition);
    }
    return groups;
  }

  /** Executes a tool call, converting any failure into a ToolResult. */
  async execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const handler = this.handlers.get(call.name);
    if (!handler) {
      return {
        id: call.id,
        name: call.name,
        ok: false,
        summary: `Unknown tool "${call.name}".`,
        error: {
          code: 'NOT_FOUND',
          message: `There is no tool called "${call.name}". Use one of the available tools.`,
          retryable: false,
          details: { available: [...this.handlers.keys()] },
        },
      };
    }

    const validation = validateArguments(handler.definition, call.arguments);
    if (!validation.valid) {
      return {
        id: call.id,
        name: call.name,
        ok: false,
        summary: validation.error ?? 'Invalid arguments.',
        error: {
          code: 'INVALID_ARGS',
          message: validation.error ?? 'Invalid arguments.',
          retryable: false,
          details: { expected: handler.definition.parameters },
        },
      };
    }

    const started = Date.now();
    try {
      const result = await handler.execute(call.arguments, ctx);
      return { ...result, durationMs: result.durationMs ?? Date.now() - started };
    } catch (err) {
      const error = CelesteError.from(err);
      const shape = error.toShape();
      return {
        id: call.id,
        name: call.name,
        ok: false,
        summary: error.message,
        error: {
          code: shape.code as ToolResult['error'] extends undefined
            ? never
            : NonNullable<ToolResult['error']>['code'],
          message: shape.message,
          retryable: shape.retryable,
          ...(shape.details !== undefined ? { details: shape.details } : {}),
        },
        durationMs: Date.now() - started,
      };
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Argument validation                                                        */
/* -------------------------------------------------------------------------- */

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * A pragmatic subset of JSON-schema validation: required properties, type
 * checks for primitives and arrays, and enum membership. Enough to catch the
 * mistakes models actually make, without pulling in a schema library.
 */
export function validateArguments(
  definition: ToolDefinition,
  args: Record<string, unknown>,
): ValidationResult {
  const schema = definition.parameters;
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];

  for (const key of required) {
    const value = args[key];
    if (value === undefined || value === null || value === '') {
      return { valid: false, error: `Missing required argument "${key}".` };
    }
  }

  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    const prop = properties[key];
    if (!prop) {
      if (schema.additionalProperties === false) {
        return { valid: false, error: `Unknown argument "${key}".` };
      }
      continue;
    }
    const typeError = checkType(value, prop);
    if (typeError) return { valid: false, error: typeError };
    if (prop.enum && !prop.enum.includes(value as string)) {
      return {
        valid: false,
        error: `Argument "${key}" must be one of: ${prop.enum.join(', ')}.`,
      };
    }
  }

  return { valid: true };
}

function checkType(value: unknown, prop: { type: string; items?: { type: string } }): string | null {
  switch (prop.type) {
    case 'string':
      return typeof value === 'string' ? null : `Expected a string, received ${typeName(value)}.`;
    case 'number':
    case 'integer':
      return typeof value === 'number' && Number.isFinite(value)
        ? prop.type === 'integer' && !Number.isInteger(value)
          ? 'Expected an integer.'
          : null
        : `Expected a number, received ${typeName(value)}.`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `Expected a boolean, received ${typeName(value)}.`;
    case 'array':
      if (!Array.isArray(value)) return `Expected an array, received ${typeName(value)}.`;
      if (prop.items) {
        for (const item of value) {
          const itemError = checkType(item, prop.items);
          if (itemError) return itemError;
        }
      }
      return null;
    case 'object':
      return typeof value === 'object' && value !== null
        ? null
        : `Expected an object, received ${typeName(value)}.`;
    default:
      return null;
  }
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
