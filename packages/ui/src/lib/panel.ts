/**
 * Panel-mode detection.
 *
 * The same client runs in two places:
 *
 * 1. **Standalone** - a normal page (`http://localhost:5173`) with the session
 *    list on the left and the status bar at the bottom.
 * 2. **Side panel** - docked to the right of a web page, roughly 400px wide,
 *    where the chrome is noise and the thread is everything.
 *
 * Panel mode is detected from the `data-celeste-panel="true"` attribute the
 * extension's `sidepanel.html` sets on `<html>`, or from a viewport narrower
 * than 640px (a docked panel, a phone, a narrow window).
 */

import { useEffect, useRef, useState } from 'react';

/** The attribute the extension sets on `<html>` to request panel mode. */
export const PANEL_DATASET_ATTRIBUTE = 'data-celeste-panel';

/** Below this width the client behaves like a docked panel. */
export const PANEL_BREAKPOINT = 640;

/**
 * A `matchMedia` subscription.
 *
 * Kept deliberately small: the client only needs "is the viewport narrow?".
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const list = window.matchMedia(query);
    const handler = (event: MediaQueryListEvent) => setMatches(event.matches);
    setMatches(list.matches);
    list.addEventListener('change', handler);
    return () => list.removeEventListener('change', handler);
  }, [query]);

  return matches;
}

/** Reads the panel flag the extension writes into the document. */
export function readPanelFlag(): boolean {
  if (typeof document === 'undefined') return false;
  const root = document.documentElement;
  return (
    root.getAttribute(PANEL_DATASET_ATTRIBUTE) === 'true' || root.dataset['celestePanel'] === 'true'
  );
}

/**
 * True when the client should render as a side panel.
 *
 * The attribute wins (the extension knows it is a panel), the viewport width
 * catches everything else. The resolved state is mirrored back onto `<html>`
 * so the stylesheet can tighten the layout for a width-based panel too - the
 * attribute is the only channel CSS has.
 */
export function usePanelMode(): boolean {
  const narrow = useMediaQuery(`(max-width: ${PANEL_BREAKPOINT - 1}px)`);
  const [flagged] = useState(readPanelFlag);
  const owned = useRef(false);

  const panel = flagged || narrow;

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    if (panel) {
      if (root.getAttribute(PANEL_DATASET_ATTRIBUTE) !== 'true') {
        root.setAttribute(PANEL_DATASET_ATTRIBUTE, 'true');
        owned.current = true;
      }
      return;
    }
    if (owned.current) {
      root.removeAttribute(PANEL_DATASET_ATTRIBUTE);
      owned.current = false;
    }
  }, [panel]);

  return panel;
}
