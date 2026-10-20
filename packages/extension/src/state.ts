/**
 * In-memory stores owned by the background service worker.
 *
 * The MV3 service worker can be evicted at any time, so these buffers are
 * deliberately simple and bounded: they are a rolling window over "what just
 * happened", not a durable audit log. The daemon re-syncs by taking a fresh
 * snapshot whenever it needs certainty.
 */

import type { NetworkEntry } from './protocol.js';
import type { ConsoleEntry, DownloadEntry } from './types.js';

const MAX_NETWORK_ENTRIES = 500;
const MAX_CONSOLE_ENTRIES = 500;
const MAX_DOWNLOADS = 100;

/** A bounded FIFO buffer that keeps insertion order. */
class RingBuffer<T> {
  private readonly items: T[] = [];

  constructor(private readonly limit: number) {}

  push(item: T): void {
    this.items.push(item);
    while (this.items.length > this.limit) this.items.shift();
  }

  all(): T[] {
    return this.items.slice();
  }

  clear(): void {
    this.items.length = 0;
  }

  get size(): number {
    return this.items.length;
  }
}

/** A network entry plus the tab it was captured from. */
export interface TaggedNetworkEntry {
  tabId: number;
  entry: NetworkEntry;
}

/** A console entry plus the tab it was captured from. */
export interface TaggedConsoleEntry {
  tabId: number;
  entry: ConsoleEntry;
}

export const networkLog = new RingBuffer<TaggedNetworkEntry>(MAX_NETWORK_ENTRIES);
export const consoleLog = new RingBuffer<TaggedConsoleEntry>(MAX_CONSOLE_ENTRIES);
export const downloadLog = new RingBuffer<DownloadEntry>(MAX_DOWNLOADS);

/** Last time we saw network traffic for a given tab (used for networkidle). */
const lastNetworkActivity = new Map<number, number>();

/** Monotonic id generator for network entries created by the content script. */
let networkCounter = 0;

export function nextNetworkId(): string {
  networkCounter += 1;
  return `n${networkCounter}_${Date.now().toString(36)}`;
}

export function recordNetworkEntry(tabId: number, entry: NetworkEntry): void {
  networkLog.push({ tabId, entry });
  lastNetworkActivity.set(tabId, Date.now());
}

export function markNetworkActivity(tabId: number): void {
  lastNetworkActivity.set(tabId, Date.now());
}

export function lastNetworkAt(tabId: number): number {
  return lastNetworkActivity.get(tabId) ?? 0;
}

export function forgetTab(tabId: number): void {
  lastNetworkActivity.delete(tabId);
}
