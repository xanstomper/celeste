/**
 * Celeste popup (vanilla TypeScript — no framework, tiny bundle).
 *
 * Shows the daemon connection state, the active tab, lets the user ping the
 * daemon and change the bridge port.
 */

import type { BridgeState, StatusResponse } from '../types.js';

const STATUS_LABEL: Record<BridgeState['status'], string> = {
  idle: 'Idle',
  connecting: 'Connecting…',
  connected: 'Connected',
  disconnected: 'Disconnected',
  error: 'Error',
};

const els = {
  dot: document.getElementById('status-dot'),
  status: document.getElementById('status-text'),
  detail: document.getElementById('status-detail'),
  url: document.getElementById('tab-url'),
  title: document.getElementById('tab-title'),
  favicon: document.getElementById('tab-favicon') as HTMLImageElement | null,
  ping: document.getElementById('ping') as HTMLButtonElement | null,
  pingResult: document.getElementById('ping-result'),
  port: document.getElementById('port') as HTMLInputElement | null,
  save: document.getElementById('save-port') as HTMLButtonElement | null,
};

function setStatus(state: BridgeState): void {
  if (els.dot) els.dot.dataset['state'] = state.status;
  if (els.status) els.status.textContent = STATUS_LABEL[state.status] ?? state.status;
  if (els.detail) {
    els.detail.textContent = state.url
      ? `${state.url}${state.lastError ? ` — ${state.lastError}` : ''}`
      : state.lastError ?? 'No bridge configured.';
  }
  if (els.port && document.activeElement !== els.port) {
    els.port.value = String(state.port || 9223);
  }
}

async function loadStatus(): Promise<void> {
  try {
    const response = (await chrome.runtime.sendMessage({ type: 'celeste:status' })) as StatusResponse;
    if (response && response.ok && response.state) {
      setStatus(response.state);
    } else {
      setStatus({
        status: 'error',
        port: 9223,
        url: '',
        attempts: 0,
        lastError: response?.error ?? 'The background worker did not answer.',
      });
    }
  } catch (err) {
    setStatus({
      status: 'error',
      port: 9223,
      url: '',
      attempts: 0,
      lastError: err instanceof Error ? err.message : String(err),
    });
  }
}

async function loadTab(): Promise<void> {
  try {
    const response = (await chrome.runtime.sendMessage({ type: 'celeste:tab-info' })) as {
      ok: boolean;
      tab?: { title: string; url: string; favIconUrl?: string } | null;
    };
    const tab = response?.tab;
    if (els.title) els.title.textContent = tab?.title || 'No active tab';
    if (els.url) els.url.textContent = tab?.url || '';
    if (els.favicon) {
      if (tab?.favIconUrl) {
        els.favicon.src = tab.favIconUrl;
        els.favicon.hidden = false;
      } else {
        els.favicon.hidden = true;
      }
    }
  } catch {
    if (els.title) els.title.textContent = 'No active tab';
  }
}

async function pingDaemon(): Promise<void> {
  if (!els.ping || !els.pingResult) return;
  els.ping.disabled = true;
  els.ping.textContent = 'Pinging…';
  const startedAt = Date.now();
  try {
    const response = (await chrome.runtime.sendMessage({ type: 'celeste:ping' })) as {
      ok: boolean;
      latencyMs?: number;
      error?: string;
    };
    const elapsed = response?.latencyMs ?? Date.now() - startedAt;
    els.pingResult.textContent = response?.ok ? `Daemon answered in ${elapsed}ms.` : `Ping failed: ${response?.error ?? 'unknown error'}`;
    els.pingResult.dataset['state'] = response?.ok ? 'ok' : 'error';
  } catch (err) {
    els.pingResult.textContent = `Ping failed: ${err instanceof Error ? err.message : String(err)}`;
    els.pingResult.dataset['state'] = 'error';
  } finally {
    els.ping.disabled = false;
    els.ping.textContent = 'Ping daemon';
  }
}

async function savePort(): Promise<void> {
  if (!els.port || !els.save) return;
  const port = Number.parseInt(els.port.value, 10);
  if (!Number.isFinite(port) || port <= 0 || port >= 65536) {
    if (els.pingResult) {
      els.pingResult.textContent = 'Port must be between 1 and 65535.';
      els.pingResult.dataset['state'] = 'error';
    }
    return;
  }
  els.save.disabled = true;
  try {
    const response = (await chrome.runtime.sendMessage({ type: 'celeste:set-port', port })) as {
      ok: boolean;
      state?: BridgeState;
      error?: string;
    };
    if (response?.ok) {
      if (response.state) setStatus(response.state);
      if (els.pingResult) {
        els.pingResult.textContent = `Bridge port set to ${port}.`;
        els.pingResult.dataset['state'] = 'ok';
      }
    } else {
      if (els.pingResult) {
        els.pingResult.textContent = `Could not set the port: ${response?.error ?? 'unknown error'}`;
        els.pingResult.dataset['state'] = 'error';
      }
    }
  } catch (err) {
    if (els.pingResult) {
      els.pingResult.textContent = `Could not set the port: ${err instanceof Error ? err.message : String(err)}`;
      els.pingResult.dataset['state'] = 'error';
    }
  } finally {
    els.save.disabled = false;
  }
}

chrome.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as { type?: string; state?: BridgeState } | undefined;
  if (msg?.type === 'celeste:state' && msg.state) setStatus(msg.state);
  return false;
});

els.ping?.addEventListener('click', () => {
  void pingDaemon();
});
els.save?.addEventListener('click', () => {
  void savePort();
});
els.port?.addEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key === 'Enter') void savePort();
});

void loadStatus();
void loadTab();
window.setInterval(() => {
  void loadStatus();
}, 2000);
