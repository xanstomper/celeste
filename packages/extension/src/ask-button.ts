/**
 * The in-page "Ask" affordance.
 *
 * A small floating button that sits in the corner of every page and opens
 * the Celeste side panel. Clicking it is a user gesture, which is what
 * `chrome.sidePanel.open()` requires.
 */

const HOST_ID = 'celeste-ask-root';
const STYLE_ID = 'celeste-ask-style';

const STYLE = `
#${HOST_ID} {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 2147483647;
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
#${HOST_ID} .celeste-ask-btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 36px;
  padding: 0 15px 0 12px;
  border: 1px solid rgba(0,0,0,0.09);
  border-radius: 999px;
  background: #ffffff;
  color: #1c1c1e;
  font-size: 13.5px;
  font-weight: 550;
  letter-spacing: -0.01em;
  cursor: pointer;
  box-shadow: 0 1px 2px rgba(0,0,0,0.06), 0 6px 20px rgba(0,0,0,0.12);
  transition: transform 140ms cubic-bezier(.2,.8,.25,1), box-shadow 140ms ease, opacity 140ms ease;
  -webkit-font-smoothing: antialiased;
}
#${HOST_ID} .celeste-ask-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 2px 4px rgba(0,0,0,0.08), 0 10px 28px rgba(0,0,0,0.16);
}
#${HOST_ID} .celeste-ask-btn:active { transform: translateY(0); }
#${HOST_ID} .celeste-ask-btn:focus-visible {
  outline: 2px solid #1d7a8c;
  outline-offset: 2px;
}
#${HOST_ID} .celeste-ask-btn svg { width: 16px; height: 16px; display: block; }
#${HOST_ID} .celeste-ask-btn[hidden] { display: none; }
@media (prefers-color-scheme: dark) {
  #${HOST_ID} .celeste-ask-btn {
    background: #1c1c20;
    color: #ececf1;
    border-color: rgba(255,255,255,0.12);
    box-shadow: 0 1px 2px rgba(0,0,0,0.5), 0 6px 20px rgba(0,0,0,0.45);
  }
}
`;

const ICON = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <path d="M12 3.2c-4.9 0-8.8 3.3-8.8 7.4 0 2.4 1.3 4.5 3.3 5.9-.2 1-.8 2.3-2 3.6 2.3-.2 4.2-1 5.5-2 0.7.1 1.3.2 2 .2 4.9 0 8.8-3.3 8.8-7.4S16.9 3.2 12 3.2Z"
    stroke="#1d7a8c" stroke-width="1.6" stroke-linejoin="round"/>
  <path d="M9.2 10.6h5.6M9.2 13.4h3.6" stroke="#1d7a8c" stroke-width="1.6" stroke-linecap="round"/>
</svg>`;

function inject(): void {
  if (document.getElementById(HOST_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.documentElement.appendChild(style);

  const host = document.createElement('div');
  host.id = HOST_ID;

  const button = document.createElement('button');
  button.className = 'celeste-ask-btn';
  button.type = 'button';
  button.setAttribute('aria-label', 'Ask Celeste about this page');
  button.innerHTML = `${ICON}<span>Ask</span>`;
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();

    // Ask the daemon to work on this page. The request travels over the
    // bridge the extension already holds open, so the agent picks it up
    // straight away and you watch it happen in the side panel.
    try {
      chrome.runtime.sendMessage(
        {
          type: 'celeste:ask',
          url: location.href,
          title: document.title,
        },
        () => void chrome.runtime.lastError,
      );
    } catch {
      /* ignore */
    }
  });

  host.appendChild(button);
  document.documentElement.appendChild(host);
}

function remove(): void {
  document.getElementById(HOST_ID)?.remove();
  document.getElementById(STYLE_ID)?.remove();
}

export function installAskButton(): void {
  if (location.protocol === 'chrome-extension:' || location.protocol === 'about:') return;
  try {
    inject();
  } catch {
    /* ignore */
  }
}

export function removeAskButton(): void {
  try {
    remove();
  } catch {
    /* ignore */
  }
}
