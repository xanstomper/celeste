import { useEffect, useState } from 'react';

/**
 * A tiny typewriter.
 *
 * The daemon delivers whole assistant messages, so on its own the thread feels
 * like a form letter. Revealing the newest answer character by character
 * gives it the cadence of a real assistant - and the reveal is skipped
 * entirely when the reader asked for reduced motion.
 */

/** Tracks the `prefers-reduced-motion` media query. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const list = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handler = (event: MediaQueryListEvent) => setReduced(event.matches);
    setReduced(list.matches);
    list.addEventListener('change', handler);
    return () => list.removeEventListener('change', handler);
  }, []);

  return reduced;
}

/**
 * Reveals `text` progressively while `active` is true.
 *
 * When `active` flips to false - because a newer answer arrived - the text
 * snaps to its full length, so an old answer never stays half-written.
 */
export function useTypewriter(text: string, active: boolean): string {
  const reduceMotion = usePrefersReducedMotion();
  const [revealed, setRevealed] = useState(text);

  useEffect(() => {
    if (!active || reduceMotion || text.length === 0) {
      setRevealed(text);
      return;
    }

    let frame = 0;
    let index = 0;
    // Roughly 80 frames for any length, so long answers do not crawl.
    const step = Math.max(1, Math.ceil(text.length / 80));
    setRevealed('');

    const tick = () => {
      index = Math.min(text.length, index + step);
      setRevealed(text.slice(0, index));
      if (index < text.length) frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [text, active, reduceMotion]);

  return revealed;
}
