/**
 * "Ask about this" on a selection.
 *
 * Select any passage on a page and a small bubble appears next to it. Click
 * it and the agent gets the page *and* the passage you were looking at, so
 * it answers the thing you actually meant instead of the whole document.
 */

const SELECT_ID = 'celeste-select-root';

const STYLE = `
#${SELECT_ID} {
  position: absolute;
  z-index: 2147483647;
  display: none;
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}
#${SELECT_ID}[data-visible="true"] { display: block; }
#${SELECT_ID} .celeste-select-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px 0 9px;
  border: 0;
  border-radius: 999px;
  background: #1d7a8c;
  color: #ffffff;
  font-size: 12.5px;
  font-weight: 550;
  letter-spacing: -0.005em;
  cursor: pointer;
  box-shadow: 0 2px 6px rgba(0,0,0,0.18), 0 8px 24px rgba(0,0,0,0.22);
  animation: celeste-select-in 140ms cubic-bezier(.2,.8,.25,1);
}
#${SELECT_ID} .celeste-select-btn:hover { background: #175f6d; }
#${SELECT_ID} .celeste-select-btn:focus-visible {
  outline: 2px solid #ffffff;
  outline-offset: 2px;
}
#${SELECT_ID} .celeste-select-btn svg { width: 14px; height: 14px; display: block; }
@keyframes celeste-select-in {
  from { opacity: 0; transform: translateY(4px) scale(0.96); }
  to { opacity: 1; transform: none; }
}
@media (prefers-color-scheme: dark) {
  #${SELECT_ID} .celeste-select-btn { background: #2a94a8; }
  #${SELECT_ID} .celeste-select-btn:hover { background: #237f91; }
}
`;

const ICON = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <path d="M12 3.2c-4.9 0-8.8 3.3-8.8 7.4 0 2.4 1.3 4.5 3.3 5.9-.2 1-.8 2.3-2 3.6 2.3-.2 4.2-1 5.5-2 .7.1 1.3.2 2 .2 4.9 0 8.8-3.3 8.8-7.4S16.9 3.2 12 3.2Z"
    stroke="#ffffff" stroke-width="1.6" stroke-linejoin="round"/>
  <path d="M9.2 10.6h5.6M9.2 13.4h3.6" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round"/>
</svg>`;

/** The longest passage we will send. */
const MAX_SELECTION = 4000;

let bubble: HTMLElement | null = null;
let hideTimer: number | null = null;

function ensureBubble(): HTMLElement {
  if (bubble) return bubble;

  if (!document.getElementById(SELECT_ID)) {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.documentElement.appendChild(style);
  }

  const host = document.createElement('div');
  host.id = SELECT_ID;

  const button = document.createElement('button');
  button.className = 'celeste-select-btn';
  button.type = 'button';
  button.innerHTML = `${ICON}<span>Ask Celeste</span>`;
  button.addEventListener('mousedown', (event) => {
    // Keep the selection alive while the button is pressed.
    event.preventDefault();
  });
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const selection = window.getSelection()?.toString().trim() ?? '';
    hide();
    if (!selection) return;
    try {
      chrome.runtime.sendMessage(
        {
          type: 'celeste:ask',
          url: location.href,
          title: document.title,
          selection: selection.slice(0, MAX_SELECTION),
        },
        () => void chrome.runtime.lastError,
      );
    } catch {
      /* ignore */
    }
  });

  host.appendChild(button);
  document.documentElement.appendChild(host);
  bubble = host;
  return host;
}

function hide(): void {
  bubble?.setAttribute('data-visible', 'false');
  if (hideTimer !== null) {
    window.clearTimeout(hideTimer);
    hideTimer = null;
  }
}

function showForSelection(): void {
  const selection = window.getSelection();
  const text = selection?.toString().trim() ?? '';
  if (!selection || text.length < 3 || selection.rangeCount === 0) {
    hide();
    return;
  }

  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    hide();
    return;
  }

  const host = ensureBubble();
  host.setAttribute('data-visible', 'true');
  // Measure after showing so the bubble knows its own size.
  const bubbleWidth = host.offsetWidth || 120;
  const bubbleHeight = host.offsetHeight || 30;

  const left = Math.min(
    Math.max(rect.left + rect.width / 2 - bubbleWidth / 2, 8),
    window.innerWidth - bubbleWidth - 8,
  );
  const above = rect.top - bubbleHeight - 8;
  const top = above > 8 ? above : rect.bottom + 8;

  host.style.left = `${left + window.scrollX}px`;
  host.style.top = `${top + window.scrollY}px`;

  if (hideTimer !== null) window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(hide, 12_000);
}

/** Watches for selections and shows the bubble above them. */
export function installSelectionBubble(): void {
  if (location.protocol === 'chrome-extension:' || location.protocol === 'about:') return;

  document.addEventListener(
    'mouseup',
    () => {
      // Let the browser finish updating the selection first.
      window.setTimeout(showForSelection, 10);
    },
    true,
  );

  document.addEventListener(
    'keyup',
    (event) => {
      if (event.key === 'Shift' || event.key.startsWith('Arrow')) {
        window.setTimeout(showForSelection, 10);
      }
    },
    true,
  );

  window.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
  document.addEventListener('mousedown', (event) => {
    const target = event.target as Node | null;
    if (target && bubble?.contains(target)) return;
    hide();
  }, true);
}

export function removeSelectionBubble(): void {
  hide();
  document.getElementById(SELECT_ID)?.remove();
  bubble = null;
}
