/**
 * PPTX renderer (pptxgenjs).
 *
 * Builds a 16:9 deck: a title slide, then one slide per {@link SlideSpec},
 * with bullets, images, speaker notes and optional two-column layouts.
 */

import PptxGenJS from 'pptxgenjs';

import { fitImage, loadImage, resolveTheme } from './blocks.js';
import type { LoadedImage, ResolvedTheme } from './blocks.js';
import type { DeckSpec, SlideSpec } from './types.js';

/* -------------------------------------------------------------------------- */
/* Layout constants (inches)                                                  */
/* -------------------------------------------------------------------------- */

/** LAYOUT_16x9 is 10" x 5.625". */
const SLIDE_W = 10;
const SLIDE_H = 5.625;

const MARGIN_X = 0.6;
const TITLE_Y = 0.42;
const TITLE_H = 0.85;
const BODY_Y = 1.45;
const BODY_H = 3.6;

const INK = '1F2937';
const MUTED = '6B7280';

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/** Render a {@link DeckSpec} into a `.pptx` buffer. */
export async function renderPptx(spec: DeckSpec): Promise<Buffer> {
  const theme = resolveTheme(spec?.theme);
  const pptx = new PptxGenJS();

  pptx.layout = 'LAYOUT_16x9';
  pptx.author = spec?.author ?? 'Celeste';
  pptx.company = 'Celeste';
  pptx.title = spec?.title ?? 'Untitled deck';
  pptx.subject = spec?.subtitle ?? spec?.title ?? 'Untitled deck';
  pptx.revision = '1';

  // Slide 1 — the title slide.
  const titleSlide = pptx.addSlide();
  titleSlide.background = { color: 'FFFFFF' };
  titleSlide.addText(spec?.title ?? '', {
    x: MARGIN_X,
    y: 1.55,
    w: SLIDE_W - MARGIN_X * 2,
    h: 1.1,
    fontFace: theme.fontFamily,
    fontSize: 40,
    bold: true,
    color: theme.accentColor,
    align: 'left',
    valign: 'middle',
  });
  if (spec?.subtitle) {
    titleSlide.addText(spec.subtitle, {
      x: MARGIN_X,
      y: 2.7,
      w: SLIDE_W - MARGIN_X * 2,
      h: 0.6,
      fontFace: theme.fontFamily,
      fontSize: 20,
      color: MUTED,
      align: 'left',
    });
  }
  if (spec?.author) {
    titleSlide.addText(spec.author, {
      x: MARGIN_X,
      y: 3.45,
      w: SLIDE_W - MARGIN_X * 2,
      h: 0.4,
      fontFace: theme.fontFamily,
      fontSize: 13,
      color: MUTED,
      align: 'left',
    });
  }
  titleSlide.addShape(pptx.ShapeType.rect, {
    x: MARGIN_X,
    y: 1.35,
    w: 1.4,
    h: 0.06,
    fill: { color: theme.accentColor },
    line: { color: theme.accentColor, width: 0 },
  });

  // Remaining slides.
  const slides = Array.isArray(spec?.slides) ? spec.slides : [];
  for (const slide of slides) {
    await addSlide(pptx, slide, theme);
  }

  const output = await pptx.write({ outputType: 'nodebuffer' });
  return Buffer.from(output as Uint8Array);
}

/* -------------------------------------------------------------------------- */
/* Slides                                                                     */
/* -------------------------------------------------------------------------- */

async function addSlide(pptx: PptxGenJS, slide: SlideSpec, theme: ResolvedTheme): Promise<void> {
  const target = pptx.addSlide();
  target.background = { color: 'FFFFFF' };

  const layout = slide.layout ?? 'content';
  const bullets = slide.bullets ?? [];
  const bulletsRight = slide.bulletsRight ?? [];
  const twoColumn = bulletsRight.length > 0;

  if (layout === 'title') {
    // A big, centred title.
    target.addText(slide.title ?? '', {
      x: MARGIN_X,
      y: 1.6,
      w: SLIDE_W - MARGIN_X * 2,
      h: 2.4,
      fontFace: theme.fontFamily,
      fontSize: 40,
      bold: true,
      color: theme.accentColor,
      align: 'center',
      valign: 'middle',
    });
  } else if (layout === 'section') {
    // A section divider: large title on the left, an accent rule above it.
    target.addShape(pptx.ShapeType.rect, {
      x: MARGIN_X,
      y: 2.0,
      w: 1.4,
      h: 0.06,
      fill: { color: theme.accentColor },
      line: { color: theme.accentColor, width: 0 },
    });
    target.addText(slide.title ?? '', {
      x: MARGIN_X,
      y: 2.2,
      w: SLIDE_W - MARGIN_X * 2,
      h: 1.1,
      fontFace: theme.fontFamily,
      fontSize: 32,
      bold: true,
      color: INK,
      align: 'left',
    });
    if (bullets.length > 0) {
      target.addText(bulletRuns(bullets, theme), {
        x: MARGIN_X,
        y: 3.35,
        w: SLIDE_W - MARGIN_X * 2,
        h: 1.4,
        fontFace: theme.fontFamily,
        fontSize: 14,
        color: MUTED,
        valign: 'top',
      });
    }
  } else {
    // 'title-content' / 'content': a title bar plus body content.
    target.addText(slide.title ?? '', {
      x: MARGIN_X,
      y: TITLE_Y,
      w: SLIDE_W - MARGIN_X * 2,
      h: TITLE_H,
      fontFace: theme.fontFamily,
      fontSize: 26,
      bold: true,
      color: INK,
      align: 'left',
      valign: 'middle',
    });
    target.addShape(pptx.ShapeType.rect, {
      x: MARGIN_X,
      y: TITLE_Y + TITLE_H + 0.02,
      w: SLIDE_W - MARGIN_X * 2,
      h: 0.02,
      fill: { color: 'E5E7EB' },
      line: { color: 'E5E7EB', width: 0 },
    });

    const hasImage = Boolean(slide.imagePath);
    const columnWidth = twoColumn
      ? (SLIDE_W - MARGIN_X * 2 - 0.4) / 2
      : SLIDE_W - MARGIN_X * 2;

    if (twoColumn) {
      if (bullets.length > 0) {
        target.addText(bulletRuns(bullets, theme), {
          x: MARGIN_X,
          y: BODY_Y,
          w: columnWidth,
          h: BODY_H,
          fontFace: theme.fontFamily,
          fontSize: 15,
          color: INK,
          valign: 'top',
        });
      }
      target.addText(bulletRuns(bulletsRight, theme), {
        x: MARGIN_X + columnWidth + 0.4,
        y: BODY_Y,
        w: columnWidth,
        h: BODY_H,
        fontFace: theme.fontFamily,
        fontSize: 15,
        color: INK,
        valign: 'top',
      });
    } else if (bullets.length > 0) {
      target.addText(bulletRuns(bullets, theme), {
        x: MARGIN_X,
        y: BODY_Y,
        w: hasImage ? columnWidth * 0.55 : columnWidth,
        h: hasImage ? BODY_H : BODY_H,
        fontFace: theme.fontFamily,
        fontSize: 15,
        color: INK,
        valign: 'top',
      });
    }

    if (slide.imagePath) {
      await addImage(target, slide, twoColumn);
    }
  }

  if (slide.notes) {
    target.addNotes(slide.notes);
  }
}

/* -------------------------------------------------------------------------- */
/* Content helpers                                                            */
/* -------------------------------------------------------------------------- */

/** Build the `addText` payload for a bullet list. */
function bulletRuns(bullets: string[], theme: ResolvedTheme): PptxGenJS.TextProps[] {
  return bullets.map((bullet) => ({
    text: bullet,
    options: {
      bullet: true,
      breakLine: true,
      fontFace: theme.fontFamily,
      fontSize: 15,
      color: INK,
      paraSpaceAfter: 8,
    },
  }));
}

/** Embed the slide image, scaled to fit while preserving its aspect ratio. */
async function addImage(
  slide: PptxGenJS.Slide,
  spec: SlideSpec,
  twoColumn: boolean,
): Promise<void> {
  const source = spec.imagePath;
  if (!source) return;

  const loaded = await loadImage(source);
  if (!loaded) return;
  // PowerPoint only understands PNG, JPEG and GIF.
  if (loaded.type !== 'png' && loaded.type !== 'jpg' && loaded.type !== 'gif') return;

  // pptxgenjs measures in inches; `fitImage` works in points.
  const maxWidth = 6 * 72;
  const maxHeight = 3.4 * 72;
  const fitted = fitImage(loaded.width, loaded.height, maxWidth, maxHeight);
  const width = Math.max(0.2, fitted.width / 72);
  const height = Math.max(0.2, fitted.height / 72);

  const x = twoColumn ? SLIDE_W - MARGIN_X - width : (SLIDE_W - width) / 2;
  const y = twoColumn ? BODY_Y : BODY_Y + 0.2;

  if (source.startsWith('data:')) {
    slide.addImage({
      data: dataUriForPptx(loaded),
      x,
      y,
      w: width,
      h: height,
      altText: spec.title ?? 'slide image',
    });
    return;
  }

  slide.addImage({
    path: source,
    x,
    y,
    w: width,
    h: height,
    altText: spec.title ?? 'slide image',
  });
}

/**
 * pptxgenjs expects base64 image data without the `data:` scheme prefix,
 * e.g. `image/png;base64,....`.
 */
function dataUriForPptx(image: LoadedImage): string {
  const mime = `image/${image.type === 'jpg' ? 'jpeg' : image.type}`;
  return `${mime};base64,${image.data.toString('base64')}`;
}
