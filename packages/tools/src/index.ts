export * from './types.js';
export * from './registry.js';
export * from './browser-tools.js';
export * from './file-tools.js';
export * from './document-tools.js';
export * from './memory-tools.js';
export * from './search-tools.js';
export * from './canvas-tools.js';

import { ToolRegistry } from './registry.js';
import { createBrowserTools } from './browser-tools.js';
import { createFileTools } from './file-tools.js';
import { createDocumentTools } from './document-tools.js';
import { createMemoryTools } from './memory-tools.js';
import { createSearchTools } from './search-tools.js';
import { createCanvasTools } from './canvas-tools.js';
import type { BrowserClient } from './types.js';

export interface BuildRegistryOptions {
  browser: BrowserClient;
  /** Directories the agent may read and write in. */
  allowedRoots: string[];
  /** Default browser command timeout. */
  browserTimeoutMs?: number;
}

/**
 * Builds the complete tool registry for a Celeste session.
 */
export function buildRegistry(options: BuildRegistryOptions): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerAll(createBrowserTools({
    browser: options.browser,
    timeoutMs: options.browserTimeoutMs,
  }));
  registry.registerAll(createFileTools({ allowedRoots: options.allowedRoots }));
  registry.registerAll(createDocumentTools());
  registry.registerAll(createMemoryTools());
  registry.registerAll(createSearchTools());
  registry.registerAll(createCanvasTools());
  return registry;
}
