/**
 * The live viewport.
 *
 * Not a screenshot every few seconds - a continuous stream of frames of the
 * page the user is actually looking at, the way a remote-desktop view works.
 * The extension captures the visible tab and pushes frames to the daemon,
 * which relays them to the panel.
 *
 * Frames are dropped when the page has not changed, so an idle browser costs
 * almost nothing.
 */

const FRAME_INTERVAL_MS = 170; // ~6 frames a second: smooth enough to follow
const MIN_FRAME_CHARS = 1200; // below this the page is blank - do not send it

export interface ViewportFrame {
  /** base64 payload, without the data-url prefix. */
  data: string;
  mimeType: string;
  tabId: number;
  windowId: number;
}

type FrameSink = (frame: ViewportFrame) => void;

let sink: FrameSink | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let windowId: number | null = null;
let tabId: number | null = null;
let lastPayload = '';

export function isViewportRunning(): boolean {
  return timer !== null;
}

/**
 * Registers where frames go.
 *
 * The background worker owns the websocket to the daemon, so it registers
 * the sink rather than the viewport module reaching for it.
 */
export function setFrameSink(next: FrameSink | null): void {
  sink = next;
}

/** Starts streaming frames of the active tab. */
export async function startViewport(
  onFrame: (frame: ViewportFrame) => void,
): Promise<{ tabId: number; windowId: number }> {
  await stopViewport();

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab || typeof tab.id !== 'number') throw new Error('No active tab to stream.');
  tabId = tab.id;
  windowId = tab.windowId ?? null;

  const tick = async (): Promise<void> => {
    if (windowId === null) return;
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
        format: 'jpeg',
        quality: 55,
      });
      if (!dataUrl) return;
      const comma = dataUrl.indexOf(',');
      if (comma < 0) return;
      const meta = dataUrl.slice(0, comma);
      const data = dataUrl.slice(comma + 1);
      // An unchanged page produces a nearly identical frame; skip it.
      if (data.length < MIN_FRAME_CHARS) return;
      if (data === lastPayload) return;
      lastPayload = data;
      const mimeType = /data:(image\/[a-z0-9.+-]+)/i.exec(meta)?.[1] ?? 'image/jpeg';
      onFrame({ data, mimeType, tabId: tabId ?? 0, windowId });
      sink?.({ data, mimeType, tabId: tabId ?? 0, windowId });
    } catch {
      /* the window may be closed, or capture may be temporarily blocked */
    }
  };

  timer = setInterval(() => {
    void tick();
  }, FRAME_INTERVAL_MS);
  await tick();

  return { tabId: tabId ?? 0, windowId: windowId ?? 0 };
}

/** Stops the stream. */
export async function stopViewport(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  windowId = null;
  tabId = null;
  lastPayload = '';
}
