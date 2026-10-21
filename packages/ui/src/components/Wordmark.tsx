import { useId } from 'react';

/**
 * The Celeste mark.
 *
 * A small teal disc with a four-point spark cut out of it - the same shape
 * language Perplexity uses for its own assistant glyph. It is drawn inline as
 * SVG (no emoji, no icon font, no network request) so it inherits the theme
 * and stays crisp at any size.
 */

export interface CelesteGlyphProps {
  size?: number;
  className?: string;
}

/** The mark on its own. */
export function CelesteGlyph({ size = 20, className }: CelesteGlyphProps) {
  // `useId` is unique but contains characters that are not valid in a CSS
  // `url(#id)` reference, so the gradient id is sanitised.
  const gradientId = `celeste-mark-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;

  return (
    <svg
      className={className ? `celeste-glyph ${className}` : 'celeste-glyph'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label="Celeste"
      focusable="false"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#38a2b4" />
          <stop offset="100%" stopColor="#1d7a8c" />
        </linearGradient>
      </defs>
      <circle cx="12" cy="12" r="10.4" fill={`url(#${gradientId})`} />
      <path
        d="M12 5.1 13.55 10.05 18.6 11.6 13.55 13.15 12 18.1 10.45 13.15 5.4 11.6 10.45 10.05Z"
        fill="#ffffff"
      />
    </svg>
  );
}

export interface WordmarkProps {
  /** Size of the glyph in pixels. */
  size?: number;
  className?: string;
  /** Render only the glyph (used when the panel is very narrow). */
  glyphOnly?: boolean;
}

/** The wordmark: the teal glyph plus the product name. */
export function Wordmark({ size = 22, className, glyphOnly = false }: WordmarkProps) {
  const classes = ['wordmark', glyphOnly ? 'wordmark--glyph' : '', className ?? '']
    .filter(Boolean)
    .join(' ');

  return (
    <span className={classes}>
      <CelesteGlyph size={size} className="wordmark__glyph" />
      {glyphOnly ? null : <span className="wordmark__text">Celeste</span>}
    </span>
  );
}
