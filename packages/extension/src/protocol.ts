/**
 * Single import surface for the Celeste wire protocol.
 *
 * Every extension module imports protocol types/helpers from here instead of
 * reaching into `@celeste/protocol` directly. That keeps the dependency in one
 * place and makes it trivial to swap the implementation for a vendored copy if
 * the workspace link ever becomes unavailable (see `VITE_PROTOCOL_ALIAS` in
 * `vite.config.ts`).
 *
 * NOTE: `src/content.ts` and `src/popup/*` deliberately import *types only*
 * from this module. Type-only imports are erased at compile time, which keeps
 * the content script bundle free of protocol runtime code (it runs in every
 * page the user visits, so size matters).
 */

export type {
  BrowserAction,
  BrowserCommand,
  BrowserCommandEnvelope,
  BrowserCommandMap,
  BrowserResultEnvelope,
  ClientMessage,
  ElementRef,
  ExtensionEvent,
  NetworkEntry,
  PageSnapshot,
  ProtocolErrorShape,
  ServerMessage,
  SnapshotElement,
  TabInfo,
  ToolErrorCode,
} from '@celeste/protocol';

export {
  BROWSER_ACTIONS,
  CelesteError,
  PROTOCOL_VERSION,
  TimeoutError,
  createId,
  decodeServerMessage,
  encodeClientMessage,
} from '@celeste/protocol';
