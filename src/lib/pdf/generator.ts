import fs from 'node:fs/promises';
import path from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import {
  PDFDocument,
  clip,
  closePath,
  degrees,
  endPath,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  translate,
  type PDFFont,
  type PDFImage,
  type PDFPage,
  type RGB,
} from 'pdf-lib';
import sharp from 'sharp';
import {
  FORMAT_LAYOUT_SPECS,
  MAX_BLEED_MM,
  MAX_SPINE_MM,
  MIN_BLEED_MM,
  MIN_SPINE_MM,
  PDF_LAYOUT_MODES,
  POLISH_ORPHANS,
  PT_PER_MM,
  computeCropMarkSegments,
  computeDefaultSpineMm,
  computePrepressBoxes,
  getFormatLayoutSpec,
  isPdfEncodableCodePoint,
  mmToPoints,
  type PdfBoxRect,
  type PdfLayoutMode,
} from '@/lib/pdf/layout-spec';
import { declinePolishName, formatAgeYears } from '@/lib/polish/inflection';
import { ART_STYLE_META } from '@/lib/polish/prompts';
import { detectImageMime, resolveSafeChildPath } from '@/lib/storage/security';
import { readStoryAsset } from '@/lib/storage/store';
import {
  DEMO_ASSET_PATH_REGEX,
  type BookFormat,
  type StoryPage,
  type StoryRecord,
} from '@/lib/types/story';

// =============================================================================
// Public Contract & Dimensions
// =============================================================================

export interface PdfAssetResolver {
  readStoryAsset(storyId: string, filename: string): Promise<Buffer | null>;
}

export interface PdfGenerationOptions {
  /** Print bleed margin in millimeters on each edge (0..10, default 0). Standard POD bleed is 3 mm. */
  bleedMm?: number;
  /** Draws hairline corner crop marks strictly outside BleedBox in an expanded slug margin. */
  cropMarks?: boolean;
  /** Inserts decorative editorial endpaper pages so total pages are divisible by 4 (combined & interior modes). */
  padToMultipleOf4?: boolean;
  /** POD layout mode: 'combined' (default), 'interior' (dedication+pages+endpapers), or 'cover-wrap' (back|spine|front spread). */
  layoutMode?: PdfLayoutMode;
  /** Spine width in mm for 'cover-wrap' mode (3..50 mm; defaults to page-count formula >= 6 mm). */
  spineMm?: number;
}

export { PT_PER_MM, mmToPoints, type PdfLayoutMode };

export const PDF_DIMENSIONS: Readonly<
  Record<BookFormat, { width: number; height: number; label: string }>
> = {
  square: {
    width: FORMAT_LAYOUT_SPECS.square.trimWidthPt,
    height: FORMAT_LAYOUT_SPECS.square.trimHeightPt,
    label: FORMAT_LAYOUT_SPECS.square.label,
  },
  'a4-landscape': {
    width: FORMAT_LAYOUT_SPECS['a4-landscape'].trimWidthPt,
    height: FORMAT_LAYOUT_SPECS['a4-landscape'].trimHeightPt,
    label: FORMAT_LAYOUT_SPECS['a4-landscape'].label,
  },
};

// Editorial Atelier Palette
const COLOR_PAPER: RGB = rgb(0.98, 0.965, 0.933); // #FAF6EE
const COLOR_PAPER_ALT: RGB = rgb(0.957, 0.933, 0.886); // #F4EEE2
const COLOR_INK: RGB = rgb(0.149, 0.118, 0.094); // #261E18
const COLOR_INK_MUTED: RGB = rgb(0.388, 0.325, 0.275); // #635346
const COLOR_TERRACOTTA: RGB = rgb(0.624, 0.29, 0.173); // #9F4A2C
const COLOR_SAGE: RGB = rgb(0.306, 0.42, 0.345); // #4E6B58
const COLOR_GOLD: RGB = rgb(0.769, 0.604, 0.271); // #C49A45
const COLOR_RULE: RGB = rgb(0.843, 0.788, 0.706); // #D7C9B4
const COLOR_MAT: RGB = rgb(0.996, 0.992, 0.98); // #FEFDF9
const COLOR_WHITE: RGB = rgb(1, 1, 1);

interface EmbeddedFonts {
  serifRegular: PDFFont;
  serifBold: PDFFont;
  serifItalic: PDFFont;
  sansRegular: PDFFont;
  sansSemiBold: PDFFont;
}

const FONT_FILES = {
  serifRegular: 'Lora-Regular.ttf',
  serifBold: 'Lora-Bold.ttf',
  serifItalic: 'Lora-Italic.ttf',
  sansRegular: 'PlusJakartaSans-Regular.ttf',
  sansSemiBold: 'PlusJakartaSans-SemiBold.ttf',
} as const;

let cachedFontBytes: Record<keyof typeof FONT_FILES, Uint8Array> | null = null;

async function loadFontBytes(): Promise<Record<keyof typeof FONT_FILES, Uint8Array>> {
  if (cachedFontBytes) {
    return cachedFontBytes;
  }

  const fontsDir = path.join(process.cwd(), 'public', 'fonts');
  const [serifRegular, serifBold, serifItalic, sansRegular, sansSemiBold] =
    await Promise.all([
      fs.readFile(path.join(fontsDir, FONT_FILES.serifRegular)),
      fs.readFile(path.join(fontsDir, FONT_FILES.serifBold)),
      fs.readFile(path.join(fontsDir, FONT_FILES.serifItalic)),
      fs.readFile(path.join(fontsDir, FONT_FILES.sansRegular)),
      fs.readFile(path.join(fontsDir, FONT_FILES.sansSemiBold)),
    ]);

  cachedFontBytes = {
    serifRegular: new Uint8Array(serifRegular),
    serifBold: new Uint8Array(serifBold),
    serifItalic: new Uint8Array(serifItalic),
    sansRegular: new Uint8Array(sansRegular),
    sansSemiBold: new Uint8Array(sansSemiBold),
  };

  return cachedFontBytes;
}

async function embedPolishFonts(pdfDoc: PDFDocument): Promise<EmbeddedFonts> {
  const bytes = await loadFontBytes();
  const embedOptions = {
    subset: true,
    features: { liga: false },
  };

  const [serifRegular, serifBold, serifItalic, sansRegular, sansSemiBold] =
    await Promise.all([
      pdfDoc.embedFont(bytes.serifRegular, embedOptions),
      pdfDoc.embedFont(bytes.serifBold, embedOptions),
      pdfDoc.embedFont(bytes.serifItalic, embedOptions),
      pdfDoc.embedFont(bytes.sansRegular, embedOptions),
      pdfDoc.embedFont(bytes.sansSemiBold, embedOptions),
    ]);

  return {
    serifRegular,
    serifBold,
    serifItalic,
    sansRegular,
    sansSemiBold,
  };
}

// =============================================================================
// Safe Text Sanitization & Polish Orphan-Safe Wrapping
// =============================================================================

/**
 * Cleans unsupported control characters / emojis so embedded TTF fonts never throw
 * or emit `.notdef` tofu boxes, while preserving full Polish diacritics, smart quotes,
 * dashes, and ellipsis.
 */
function sanitizePdfText(raw: string, font: PDFFont): string {
  const normalized = raw
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200B-\u200F\uFEFF\uFE0E\uFE0F]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\t/g, ' ');

  const fontWithEmbedder = font as unknown as {
    embedder?: { font?: { hasGlyphForCodePoint?: (codePoint: number) => boolean } };
  };
  const hasGlyphCheck = fontWithEmbedder.embedder?.font?.hasGlyphForCodePoint;

  let out = '';
  for (const ch of normalized) {
    if (ch === '\n') {
      out += '\n';
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      continue;
    }
    if (!isPdfEncodableCodePoint(code)) {
      continue;
    }
    if (
      typeof hasGlyphCheck === 'function' &&
      !hasGlyphCheck.call(fontWithEmbedder.embedder?.font, code)
    ) {
      continue;
    }
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      if (ch === '–' || ch === '—') {
        out += '-';
      } else if (ch === '„' || ch === '”' || ch === '“' || ch === '»' || ch === '«') {
        out += '"';
      } else if (ch === '…') {
        out += '...';
      }
      // Drop unencodable emojis / private glyphs safely.
    }
  }
  return out;
}

/**
 * Word-wraps Polish prose without leaving hanging single-letter conjunctions
 * ("a", "i", "o", "u", "w", "z") at the end of a line.
 */
function wrapPolishText(
  rawText: string,
  font: PDFFont,
  fontSize: number,
  maxWidth: number,
  maxLines?: number,
): string[] {
  const clean = sanitizePdfText(rawText, font);
  const paragraphs = clean.split('\n');
  const lines: string[] = [];

  for (let pIndex = 0; pIndex < paragraphs.length; pIndex += 1) {
    const paragraph = paragraphs[pIndex].trim();
    if (!paragraph) {
      if (pIndex > 0 && pIndex < paragraphs.length - 1 && lines.length > 0) {
        lines.push('');
      }
      continue;
    }

    const rawWords = paragraph.split(/\s+/).filter(Boolean);
    // Glue single-letter Polish prepositions/conjunctions to the next word.
    const tokens: string[] = [];
    for (let i = 0; i < rawWords.length; i += 1) {
      const word = rawWords[i];
      if (POLISH_ORPHANS.has(word) && i + 1 < rawWords.length) {
        tokens.push(`${word} ${rawWords[i + 1]}`);
        i += 1;
      } else {
        tokens.push(word);
      }
    }

    let current = '';
    for (const token of tokens) {
      const candidate = current ? `${current} ${token}` : token;
      if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
        current = candidate;
        continue;
      }

      if (current) {
        lines.push(current);
        current = '';
      }

      // If single token exceeds maxWidth, split gracefully by word or character.
      if (font.widthOfTextAtSize(token, fontSize) <= maxWidth) {
        current = token;
      } else {
        const subWords = token.split(' ');
        for (const sub of subWords) {
          if (font.widthOfTextAtSize(sub, fontSize) <= maxWidth) {
            if (!current) {
              current = sub;
            } else if (font.widthOfTextAtSize(`${current} ${sub}`, fontSize) <= maxWidth) {
              current = `${current} ${sub}`;
            } else {
              lines.push(current);
              current = sub;
            }
          } else {
            let chunk = '';
            for (const ch of sub) {
              if (font.widthOfTextAtSize(chunk + ch, fontSize) <= maxWidth) {
                chunk += ch;
              } else {
                if (chunk) lines.push(chunk);
                chunk = ch;
              }
            }
            current = chunk;
          }
        }
      }
    }

    if (current) {
      lines.push(current);
    }
  }

  if (maxLines !== undefined && lines.length > maxLines) {
    const trimmed = lines.slice(0, maxLines);
    const lastIdx = trimmed.length - 1;
    let last = trimmed[lastIdx].replace(/[.,;:\s-]+$/, '');
    const ellipsis = '…';
    while (
      last.length > 1 &&
      font.widthOfTextAtSize(`${last}${ellipsis}`, fontSize) > maxWidth
    ) {
      last = last.slice(0, -1).trimEnd();
    }
    trimmed[lastIdx] = `${last}${ellipsis}`;
    return trimmed;
  }

  return lines;
}

function drawCenteredText(
  page: PDFPage,
  text: string,
  y: number,
  font: PDFFont,
  size: number,
  color: RGB,
  areaX = 0,
  areaWidth = page.getTrimBox().width,
): void {
  const safe = sanitizePdfText(text, font);
  const w = font.widthOfTextAtSize(safe, size);
  page.drawText(safe, {
    x: areaX + Math.max(0, (areaWidth - w) / 2),
    y,
    font,
    size,
    color,
  });
}

// =============================================================================
// Asset Loading & Clipping Cover Image Drawing
// =============================================================================

async function readDemoPublicAsset(demoPath: string): Promise<Buffer | null> {
  if (!DEMO_ASSET_PATH_REGEX.test(demoPath)) {
    return null;
  }
  const publicDir = path.join(process.cwd(), 'public');
  const relative = demoPath.replace(/^\/+/, '');
  try {
    const safePath = resolveSafeChildPath(publicDir, ...relative.split('/'));
    return await fs.readFile(safePath);
  } catch {
    return null;
  }
}

async function resolveImageBuffer(
  storyId: string,
  filename: string | null | undefined,
  demoPath: string | null | undefined,
  resolver: PdfAssetResolver,
): Promise<Buffer | null> {
  if (filename) {
    try {
      const stored = await resolver.readStoryAsset(storyId, filename);
      if (stored && stored.length > 0) {
        return stored;
      }
    } catch {
      // Fall through to demo asset fallback.
    }
  }
  if (demoPath) {
    return readDemoPublicAsset(demoPath);
  }
  return null;
}

async function embedBufferAsPdfImage(
  pdfDoc: PDFDocument,
  buffer: Buffer,
): Promise<PDFImage | null> {
  const mime = detectImageMime(buffer);
  try {
    if (mime === 'image/jpeg') {
      return await pdfDoc.embedJpg(buffer);
    }
    if (mime === 'image/png') {
      return await pdfDoc.embedPng(buffer);
    }
  } catch {
    // Fall through to sharp transcoding (e.g. progressive/unusual color space).
  }

  try {
    const transcoded = await sharp(buffer)
      .rotate()
      .flatten({ background: '#FAF6EE' })
      .jpeg({ quality: 88, mozjpeg: true })
      .toBuffer();
    return await pdfDoc.embedJpg(transcoded);
  } catch {
    return null;
  }
}

/**
 * Draws an image covering the target rectangle cleanly via PDF clipping path
 * (center-crop, preserving aspect ratio without distortion).
 */
function drawImageCover(
  page: PDFPage,
  image: PDFImage,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const imgRatio = image.width / image.height;
  const boxRatio = width / height;

  let drawW = width;
  let drawH = height;
  if (imgRatio > boxRatio) {
    drawH = height;
    drawW = height * imgRatio;
  } else {
    drawW = width;
    drawH = width / imgRatio;
  }

  const drawX = x + (width - drawW) / 2;
  const drawY = y + (height - drawH) / 2;

  page.pushOperators(
    pushGraphicsState(),
    moveTo(x, y),
    lineTo(x + width, y),
    lineTo(x + width, y + height),
    lineTo(x, y + height),
    closePath(),
    clip(),
    endPath(),
  );

  page.drawImage(image, {
    x: drawX,
    y: drawY,
    width: drawW,
    height: drawH,
  });

  page.pushOperators(popGraphicsState());
}

function drawPlaceholderArtworkBox(
  page: PDFPage,
  fonts: EmbeddedFonts,
  x: number,
  y: number,
  width: number,
  height: number,
  caption: string,
): void {
  page.drawRectangle({
    x,
    y,
    width,
    height,
    color: COLOR_PAPER_ALT,
    borderColor: COLOR_RULE,
    borderWidth: 1,
  });
  page.drawRectangle({
    x: x + 10,
    y: y + 10,
    width: width - 20,
    height: height - 20,
    borderColor: COLOR_GOLD,
    borderWidth: 0.6,
  });
  drawCenteredText(
    page,
    caption,
    y + height / 2 - 5,
    fonts.serifItalic,
    12,
    COLOR_INK_MUTED,
    x + 16,
    width - 32,
  );
}

function drawEditorialBorder(page: PDFPage, w: number, h: number, margin = 20): void {
  page.drawRectangle({
    x: 0,
    y: 0,
    width: w,
    height: h,
    color: COLOR_PAPER,
  });
  page.drawRectangle({
    x: margin,
    y: margin,
    width: w - margin * 2,
    height: h - margin * 2,
    borderColor: COLOR_RULE,
    borderWidth: 0.9,
  });
  page.drawRectangle({
    x: margin + 4,
    y: margin + 4,
    width: w - (margin + 4) * 2,
    height: h - (margin + 4) * 2,
    borderColor: COLOR_GOLD,
    borderWidth: 0.45,
  });
}

// =============================================================================
// Page Builders
// =============================================================================

function renderFrontCover(
  page: PDFPage,
  story: StoryRecord,
  fonts: EmbeddedFonts,
  coverImage: PDFImage | null,
  format: BookFormat,
): void {
  const spec = getFormatLayoutSpec(format);
  const w = spec.trimWidthPt;
  const h = spec.trimHeightPt;
  drawEditorialBorder(page, w, h, 18);

  if (format === 'a4-landscape') {
    // Left half artwork, right half editorial cover title panel
    const artX = 36;
    const artY = 38;
    const artW = spec.coverArt.widthPt;
    const artH = spec.coverArt.heightPt;

    page.drawRectangle({
      x: artX - 6,
      y: artY - 6,
      width: artW + 12,
      height: artH + 12,
      color: COLOR_MAT,
      borderColor: COLOR_RULE,
      borderWidth: 1,
    });

    if (coverImage) {
      drawImageCover(page, coverImage, artX, artY, artW, artH);
    } else {
      drawPlaceholderArtworkBox(
        page,
        fonts,
        artX,
        artY,
        artW,
        artH,
        'Miejsce na ilustrację okładkową',
      );
    }

    const panelX = artX + artW + 28;
    const panelW = w - panelX - 36;

    drawCenteredText(
      page,
      'PRACOWNIA BAJKOKREATOR',
      h - 76,
      fonts.sansSemiBold,
      8.5,
      COLOR_TERRACOTTA,
      panelX,
      panelW,
    );

    // Decorative gold rule
    page.drawLine({
      start: { x: panelX + panelW * 0.25, y: h - 90 },
      end: { x: panelX + panelW * 0.75, y: h - 90 },
      thickness: 0.8,
      color: COLOR_GOLD,
    });

    const titleLines = wrapPolishText(story.title, fonts.serifBold, 26, panelW - 12, 4);
    let cursorY = h - 148;
    for (const line of titleLines) {
      drawCenteredText(page, line, cursorY, fonts.serifBold, 26, COLOR_INK, panelX, panelW);
      cursorY -= 33;
    }

    const subLines = wrapPolishText(story.subtitle, fonts.serifItalic, 13, panelW - 16, 3);
    cursorY -= 10;
    for (const line of subLines) {
      drawCenteredText(
        page,
        line,
        cursorY,
        fonts.serifItalic,
        13,
        COLOR_INK_MUTED,
        panelX,
        panelW,
      );
      cursorY -= 19;
    }

    // Bottom hero badge
    const badgeY = 92;
    page.drawLine({
      start: { x: panelX + 36, y: badgeY + 34 },
      end: { x: panelX + panelW - 36, y: badgeY + 34 },
      thickness: 0.6,
      color: COLOR_RULE,
    });
    drawCenteredText(
      page,
      `Opowieść dla: ${story.input.childName}`,
      badgeY + 12,
      fonts.sansSemiBold,
      11,
      COLOR_SAGE,
      panelX,
      panelW,
    );
    drawCenteredText(
      page,
      `${formatAgeYears(story.input.childAge)} • ${ART_STYLE_META[story.input.artStyle].label}`,
      badgeY - 6,
      fonts.sansRegular,
      9,
      COLOR_INK_MUTED,
      panelX,
      panelW,
    );
    return;
  }

  // Square 21×21 cm cover
  drawCenteredText(
    page,
    'PRACOWNIA BAJKOKREATOR',
    h - 50,
    fonts.sansSemiBold,
    8.5,
    COLOR_TERRACOTTA,
    0,
    w,
  );

  const artW = spec.coverArt.widthPt;
  const artH = spec.coverArt.heightPt;
  const artMarginX = (w - artW) / 2;
  const artY = h - 66 - artH;

  page.drawRectangle({
    x: artMarginX - 7,
    y: artY - 7,
    width: artW + 14,
    height: artH + 14,
    color: COLOR_MAT,
    borderColor: COLOR_RULE,
    borderWidth: 1,
  });

  if (coverImage) {
    drawImageCover(page, coverImage, artMarginX, artY, artW, artH);
  } else {
    drawPlaceholderArtworkBox(
      page,
      fonts,
      artMarginX,
      artY,
      artW,
      artH,
      'Miejsce na ilustrację okładkową',
    );
  }

  const titleLines = wrapPolishText(story.title, fonts.serifBold, 23, w - 96, 3);
  let cursorY = artY - 36;
  for (const line of titleLines) {
    drawCenteredText(page, line, cursorY, fonts.serifBold, 23, COLOR_INK, 0, w);
    cursorY -= 28;
  }

  const subLines = wrapPolishText(story.subtitle, fonts.serifItalic, 12, w - 110, 2);
  cursorY -= 2;
  for (const line of subLines) {
    drawCenteredText(page, line, cursorY, fonts.serifItalic, 12, COLOR_INK_MUTED, 0, w);
    cursorY -= 17;
  }

  drawCenteredText(
    page,
    `Książeczka dla: ${story.input.childName} (${formatAgeYears(story.input.childAge)})`,
    44,
    fonts.sansSemiBold,
    9.5,
    COLOR_SAGE,
    0,
    w,
  );
}

function renderDedicationPage(
  page: PDFPage,
  story: StoryRecord,
  fonts: EmbeddedFonts,
  childPhoto: PDFImage | null,
  format: BookFormat,
): void {
  const spec = getFormatLayoutSpec(format);
  const w = spec.trimWidthPt;
  const h = spec.trimHeightPt;
  drawEditorialBorder(page, w, h, 24);

  const isLandscape = format === 'a4-landscape';
  const photoSize = spec.dedicationPortrait.widthPt;
  const photoX = (w - photoSize) / 2;
  const photoY = h - 94 - photoSize;

  drawCenteredText(
    page,
    'DEDYKACJA',
    h - 62,
    fonts.sansSemiBold,
    9.5,
    COLOR_TERRACOTTA,
    0,
    w,
  );

  // Double linen photo frame
  page.drawRectangle({
    x: photoX - 12,
    y: photoY - 12,
    width: photoSize + 24,
    height: photoSize + 24,
    color: COLOR_MAT,
    borderColor: COLOR_GOLD,
    borderWidth: 1.2,
  });
  page.drawRectangle({
    x: photoX - 5,
    y: photoY - 5,
    width: photoSize + 10,
    height: photoSize + 10,
    borderColor: COLOR_RULE,
    borderWidth: 0.7,
  });

  if (childPhoto) {
    drawImageCover(page, childPhoto, photoX, photoY, photoSize, photoSize);
  } else {
    drawPlaceholderArtworkBox(
      page,
      fonts,
      photoX,
      photoY,
      photoSize,
      photoSize,
      `Portret: ${story.input.childName}`,
    );
  }

  // Ornamental divider
  const dividerY = photoY - 34;
  page.drawLine({
    start: { x: w * 0.34, y: dividerY },
    end: { x: w * 0.66, y: dividerY },
    thickness: 0.8,
    color: COLOR_GOLD,
  });

  const textWidth = isLandscape ? 520 : 420;
  const dedicationLines = wrapPolishText(
    story.dedicationText,
    fonts.serifItalic,
    14,
    textWidth,
    8,
  );

  let cursorY = dividerY - 28;
  for (const line of dedicationLines) {
    drawCenteredText(page, line, cursorY, fonts.serifItalic, 14, COLOR_INK, 0, w);
    cursorY -= 22;
  }

  const childNameGenitive = declinePolishName(
    story.input.childName,
    story.input.gender,
  ).genitive;
  const trimmedFrom = story.input.dedicationFrom?.trim();
  const fromLabel = trimmedFrom
    ? `Z miłością — ${trimmedFrom}`
    : `Dla ${childNameGenitive} • ${formatAgeYears(story.input.childAge)}`;

  drawCenteredText(
    page,
    fromLabel,
    Math.max(58, cursorY - 14),
    fonts.sansSemiBold,
    10.5,
    COLOR_TERRACOTTA,
    0,
    w,
  );
}

function renderStoryPage(
  page: PDFPage,
  storyPage: StoryPage,
  totalStoryPages: number,
  fonts: EmbeddedFonts,
  artwork: PDFImage | null,
  format: BookFormat,
): void {
  const spec = getFormatLayoutSpec(format);
  const w = spec.trimWidthPt;
  const h = spec.trimHeightPt;
  drawEditorialBorder(page, w, h, 18);

  if (format === 'a4-landscape') {
    // Left half illustration, right half polished book typography
    const artX = 36;
    const artY = 44;
    const artW = spec.pageArt.widthPt;
    const artH = spec.pageArt.heightPt;

    page.drawRectangle({
      x: artX - 6,
      y: artY - 6,
      width: artW + 12,
      height: artH + 12,
      color: COLOR_MAT,
      borderColor: COLOR_RULE,
      borderWidth: 0.9,
    });

    if (artwork) {
      drawImageCover(page, artwork, artX, artY, artW, artH);
    } else {
      drawPlaceholderArtworkBox(
        page,
        fonts,
        artX,
        artY,
        artW,
        artH,
        `Ilustracja strony ${storyPage.pageNumber} (wgraj w podglądzie)`,
      );
    }

    const textX = artX + artW + 34;
    const textW = w - textX - 38;

    page.drawText(
      sanitizePdfText(
        `STRONA ${storyPage.pageNumber} Z ${totalStoryPages}`,
        fonts.sansSemiBold,
      ),
      {
        x: textX,
        y: h - 72,
        font: fonts.sansSemiBold,
        size: 8.5,
        color: COLOR_TERRACOTTA,
      },
    );

    const titleLines = wrapPolishText(
      storyPage.chapterTitle,
      fonts.serifBold,
      18,
      textW,
      3,
    );
    let cursorY = h - 102;
    for (const line of titleLines) {
      page.drawText(line, {
        x: textX,
        y: cursorY,
        font: fonts.serifBold,
        size: 18,
        color: COLOR_INK,
      });
      cursorY -= 24;
    }

    page.drawLine({
      start: { x: textX, y: cursorY + 8 },
      end: { x: textX + 64, y: cursorY + 8 },
      thickness: 1.1,
      color: COLOR_GOLD,
    });

    cursorY -= 16;
    const bodySize = storyPage.text.length > 480 ? 11.5 : 13;
    const lineHeight = bodySize * 1.56;
    const maxLines = Math.max(4, Math.floor((cursorY - 64) / lineHeight));
    const bodyLines = wrapPolishText(
      storyPage.text,
      fonts.serifRegular,
      bodySize,
      textW,
      maxLines,
    );

    for (const line of bodyLines) {
      if (line.length > 0) {
        page.drawText(line, {
          x: textX,
          y: cursorY,
          font: fonts.serifRegular,
          size: bodySize,
          color: COLOR_INK,
        });
      }
      cursorY -= lineHeight;
    }

    // Footer page number
    drawCenteredText(
      page,
      `— ${storyPage.pageNumber} —`,
      36,
      fonts.serifItalic,
      10,
      COLOR_INK_MUTED,
      textX,
      textW,
    );
    return;
  }

  // Square 21×21 cm layout: top illustration + bottom chapter heading & prose
  const artW = spec.pageArt.widthPt;
  const artH = spec.pageArt.heightPt;
  const artX = (w - artW) / 2;
  const artY = h - 38 - artH;

  page.drawRectangle({
    x: artX - 5,
    y: artY - 5,
    width: artW + 10,
    height: artH + 10,
    color: COLOR_MAT,
    borderColor: COLOR_RULE,
    borderWidth: 0.9,
  });

  if (artwork) {
    drawImageCover(page, artwork, artX, artY, artW, artH);
  } else {
    drawPlaceholderArtworkBox(
      page,
      fonts,
      artX,
      artY,
      artW,
      artH,
      `Ilustracja strony ${storyPage.pageNumber} (wgraj w podglądzie)`,
    );
  }

  const textX = 48;
  const textW = w - 96;
  const titleLines = wrapPolishText(
    storyPage.chapterTitle,
    fonts.serifBold,
    14.5,
    textW,
    2,
  );
  let cursorY = artY - 26;
  for (const line of titleLines) {
    drawCenteredText(page, line, cursorY, fonts.serifBold, 14.5, COLOR_TERRACOTTA, 0, w);
    cursorY -= 19;
  }

  cursorY -= 4;
  const bodySize = storyPage.text.length > 420 ? 10.5 : 11.5;
  const lineHeight = bodySize * 1.48;
  const maxLines = Math.max(3, Math.floor((cursorY - 46) / lineHeight));
  const bodyLines = wrapPolishText(
    storyPage.text,
    fonts.serifRegular,
    bodySize,
    textW,
    maxLines,
  );

  for (const line of bodyLines) {
    if (line.length > 0) {
      page.drawText(line, {
        x: textX,
        y: cursorY,
        font: fonts.serifRegular,
        size: bodySize,
        color: COLOR_INK,
      });
    }
    cursorY -= lineHeight;
  }

  drawCenteredText(
    page,
    `${storyPage.pageNumber} / ${totalStoryPages}`,
    31,
    fonts.sansRegular,
    9,
    COLOR_INK_MUTED,
    0,
    w,
  );
}

function renderEndpaperPage(
  page: PDFPage,
  story: StoryRecord,
  fonts: EmbeddedFonts,
  format: BookFormat,
): void {
  const spec = getFormatLayoutSpec(format);
  const w = spec.trimWidthPt;
  const h = spec.trimHeightPt;
  drawEditorialBorder(page, w, h, 24);

  const childNameGenitive = declinePolishName(
    story.input.childName,
    story.input.gender,
  ).genitive;

  drawCenteredText(
    page,
    'NOTATKI I RYSUNKI',
    h - 76,
    fonts.sansSemiBold,
    9,
    COLOR_TERRACOTTA,
    0,
    w,
  );
  drawCenteredText(
    page,
    `Miejsce na wspomnienia z czytania bajki dla ${childNameGenitive}`,
    h - 96,
    fonts.serifItalic,
    11,
    COLOR_INK_MUTED,
    0,
    w,
  );

  // Subtle horizontal dotted-style writing rules
  const lineStartX = 64;
  const lineEndX = w - 64;
  const startY = h - 146;
  const endY = 74;
  for (let y = startY; y >= endY; y -= 32) {
    page.drawLine({
      start: { x: lineStartX, y },
      end: { x: lineEndX, y },
      thickness: 0.45,
      color: COLOR_RULE,
    });
  }
}

function renderBackCover(
  page: PDFPage,
  story: StoryRecord,
  fonts: EmbeddedFonts,
  format: BookFormat,
): void {
  const spec = getFormatLayoutSpec(format);
  const w = spec.trimWidthPt;
  const h = spec.trimHeightPt;

  page.drawRectangle({ x: 0, y: 0, width: w, height: h, color: COLOR_PAPER_ALT });
  page.drawRectangle({
    x: 24,
    y: 24,
    width: w - 48,
    height: h - 48,
    color: COLOR_PAPER,
    borderColor: COLOR_RULE,
    borderWidth: 1,
  });
  page.drawRectangle({
    x: 30,
    y: 30,
    width: w - 60,
    height: h - 60,
    borderColor: COLOR_GOLD,
    borderWidth: 0.6,
  });

  drawCenteredText(
    page,
    'O TEJ KSIĄŻECZCE',
    h - 92,
    fonts.sansSemiBold,
    9.5,
    COLOR_TERRACOTTA,
    0,
    w,
  );

  const titleLines = wrapPolishText(story.title, fonts.serifBold, 20, w - 140, 3);
  let cursorY = h - 128;
  for (const line of titleLines) {
    drawCenteredText(page, line, cursorY, fonts.serifBold, 20, COLOR_INK, 0, w);
    cursorY -= 26;
  }

  page.drawLine({
    start: { x: w * 0.38, y: cursorY + 4 },
    end: { x: w * 0.62, y: cursorY + 4 },
    thickness: 0.9,
    color: COLOR_GOLD,
  });

  const blurbWidth = format === 'a4-landscape' ? 540 : 410;
  const blurbLines = wrapPolishText(
    story.backCoverBlurb,
    fonts.serifRegular,
    13,
    blurbWidth,
    10,
  );

  cursorY -= 26;
  for (const line of blurbLines) {
    drawCenteredText(page, line, cursorY, fonts.serifRegular, 13, COLOR_INK, 0, w);
    cursorY -= 21;
  }

  // Colophon box at bottom
  const colophonW = Math.min(400, w - 120);
  const colophonH = 74;
  const colophonX = (w - colophonW) / 2;
  const colophonY = 66;

  page.drawRectangle({
    x: colophonX,
    y: colophonY,
    width: colophonW,
    height: colophonH,
    color: COLOR_WHITE,
    borderColor: COLOR_RULE,
    borderWidth: 0.8,
  });

  const styleLabel = ART_STYLE_META[story.input.artStyle]?.label ?? story.input.artStyle;
  drawCenteredText(
    page,
    `Bohater: ${story.input.childName} (${formatAgeYears(story.input.childAge)}) • ${story.pages.length} stron`,
    colophonY + 46,
    fonts.sansSemiBold,
    9.5,
    COLOR_INK,
    colophonX,
    colophonW,
  );
  drawCenteredText(
    page,
    `Styl: ${styleLabel} • Format: ${spec.label}`,
    colophonY + 29,
    fonts.sansRegular,
    8.5,
    COLOR_INK_MUTED,
    colophonX,
    colophonW,
  );
  drawCenteredText(
    page,
    'Wydano w pracowni BajkoKreator',
    colophonY + 12,
    fonts.serifItalic,
    9,
    COLOR_SAGE,
    colophonX,
    colophonW,
  );
}

function renderSpinePanel(
  page: PDFPage,
  story: StoryRecord,
  fonts: EmbeddedFonts,
  spinePt: number,
  panelH: number,
): void {
  page.drawRectangle({
    x: 0,
    y: 0,
    width: spinePt,
    height: panelH,
    color: COLOR_PAPER_ALT,
  });

  const ruleInset = Math.min(4, spinePt * 0.2);
  if (spinePt - ruleInset * 2 > 1) {
    page.drawLine({
      start: { x: ruleInset, y: panelH - 28 },
      end: { x: spinePt - ruleInset, y: panelH - 28 },
      thickness: 0.7,
      color: COLOR_GOLD,
    });
    page.drawLine({
      start: { x: ruleInset, y: 28 },
      end: { x: spinePt - ruleInset, y: 28 },
      thickness: 0.7,
      color: COLOR_GOLD,
    });
  }

  const fontSize = Math.min(10.5, Math.max(5.5, spinePt * 0.48));
  const maxTextLen = Math.max(60, panelH - 110);
  let spineTitle = sanitizePdfText(story.title, fonts.serifBold).replace(/\s+/g, ' ').trim();
  if (spineTitle.length === 0) {
    return;
  }

  if (fonts.serifBold.widthOfTextAtSize(spineTitle, fontSize) > maxTextLen) {
    const ellipsis = '…';
    while (
      spineTitle.length > 1 &&
      fonts.serifBold.widthOfTextAtSize(`${spineTitle}${ellipsis}`, fontSize) > maxTextLen
    ) {
      spineTitle = spineTitle.slice(0, -1).trimEnd();
    }
    spineTitle = `${spineTitle}${ellipsis}`;
  }

  const textW = fonts.serifBold.widthOfTextAtSize(spineTitle, fontSize);
  // Under -90° rotation, text runs downward (-y) for textW and ascent extends right (+x) ~0.7*fontSize.
  const x = (spinePt - fontSize * 0.7) / 2;
  const y = (panelH + textW) / 2;

  page.drawText(spineTitle, {
    x,
    y,
    font: fonts.serifBold,
    size: fontSize,
    color: COLOR_INK,
    rotate: degrees(-90),
  });
}

// =============================================================================
// Main Export Entrypoint
// =============================================================================

const defaultAssetResolver: PdfAssetResolver = {
  async readStoryAsset(storyId: string, filename: string): Promise<Buffer | null> {
    const asset = await readStoryAsset(storyId, filename);
    return asset ? asset.buffer : null;
  },
};

function drawCropMarks(
  page: PDFPage,
  trimW: number,
  trimH: number,
  bleedPt: number,
  slugPt: number,
  foldOffsetsX: readonly number[] = [],
): void {
  if (slugPt <= 0) {
    return;
  }
  const segments = computeCropMarkSegments(trimW, trimH, bleedPt, slugPt, foldOffsetsX);
  for (const seg of segments) {
    page.drawLine({
      start: { x: seg.x1, y: seg.y1 },
      end: { x: seg.x2, y: seg.y2 },
      thickness: 0.35,
      color: COLOR_INK,
      ...(seg.kind === 'fold' ? { dashArray: [2, 2] } : {}),
    });
  }
}

function addFramedBookPage(
  pdfDoc: PDFDocument,
  trimW: number,
  trimH: number,
  bleedPt: number,
  slugPt: number,
  cropMarks: boolean,
  bleedBackground: RGB | ((page: PDFPage, bleedBox: PdfBoxRect) => void),
  renderFn: (page: PDFPage) => void,
  foldOffsetsX: readonly number[] = [],
): PDFPage {
  const { mediaBox, bleedBox, trimBox, offsetPt } = computePrepressBoxes(
    trimW,
    trimH,
    bleedPt,
    slugPt,
  );

  const page = pdfDoc.addPage([mediaBox.width, mediaBox.height]);
  page.setMediaBox(mediaBox.x, mediaBox.y, mediaBox.width, mediaBox.height);
  page.setBleedBox(bleedBox.x, bleedBox.y, bleedBox.width, bleedBox.height);
  page.setTrimBox(trimBox.x, trimBox.y, trimBox.width, trimBox.height);

  // Fill strictly within BleedBox so the slug area outside BleedBox stays white for crisp crop marks
  if (bleedPt > 0 || slugPt > 0) {
    if (typeof bleedBackground === 'function') {
      bleedBackground(page, bleedBox);
    } else {
      page.drawRectangle({
        x: bleedBox.x,
        y: bleedBox.y,
        width: bleedBox.width,
        height: bleedBox.height,
        color: bleedBackground,
      });
    }
  }

  // Translate coordinate system into the TrimBox origin so all page layouts render identically
  if (offsetPt > 0) {
    page.pushOperators(pushGraphicsState(), translate(offsetPt, offsetPt));
    renderFn(page);
    page.pushOperators(popGraphicsState());
  } else {
    renderFn(page);
  }

  if (cropMarks && slugPt > 0) {
    drawCropMarks(page, trimW, trimH, bleedPt, slugPt, foldOffsetsX);
  }

  return page;
}

export async function generateStoryPdf(
  story: StoryRecord,
  format: BookFormat,
  resolver: PdfAssetResolver = defaultAssetResolver,
  options: PdfGenerationOptions = {},
): Promise<Uint8Array> {
  const spec = getFormatLayoutSpec(format);
  if (!spec) {
    throw new Error(`Nieobsługiwany format PDF: ${String(format)}`);
  }

  const layoutMode: PdfLayoutMode = options.layoutMode ?? 'combined';
  if (!PDF_LAYOUT_MODES.includes(layoutMode)) {
    throw new Error(
      `Nieobsługiwany tryb układu PDF: ${String(layoutMode)}. Dozwolone: ${PDF_LAYOUT_MODES.join(', ')}.`,
    );
  }

  const rawBleedMm = options.bleedMm ?? 0;
  if (!Number.isFinite(rawBleedMm) || rawBleedMm < MIN_BLEED_MM || rawBleedMm > MAX_BLEED_MM) {
    throw new Error(
      `Parametr bleedMm musi mieścić się w zakresie ${MIN_BLEED_MM}–${MAX_BLEED_MM} mm.`,
    );
  }

  if (options.spineMm !== undefined) {
    if (
      !Number.isFinite(options.spineMm) ||
      options.spineMm < MIN_SPINE_MM ||
      options.spineMm > MAX_SPINE_MM
    ) {
      throw new Error(
        `Parametr spineMm musi mieścić się w zakresie ${MIN_SPINE_MM}–${MAX_SPINE_MM} mm.`,
      );
    }
  }

  const bleedPt = rawBleedMm > 0 ? mmToPoints(rawBleedMm) : 0;
  const cropMarks = Boolean(options.cropMarks);
  const slugPt = cropMarks ? mmToPoints(spec.cropMarkSlugMm) : 0;
  const padToMultipleOf4 = Boolean(options.padToMultipleOf4);

  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);

  const childNameGenitive = declinePolishName(
    story.input.childName,
    story.input.gender,
  ).genitive;

  pdfDoc.setTitle(story.title);
  pdfDoc.setAuthor('BajkoKreator');
  pdfDoc.setSubject(`Spersonalizowana bajka dla ${childNameGenitive}`);
  pdfDoc.setCreator('BajkoKreator — Pracownia Książek dla Dzieci');
  pdfDoc.setProducer('pdf-lib + @pdf-lib/fontkit');

  const fonts = await embedPolishFonts(pdfDoc);
  const panelW = spec.trimWidthPt;
  const panelH = spec.trimHeightPt;

  if (layoutMode === 'cover-wrap') {
    const spineMm = options.spineMm ?? computeDefaultSpineMm(story.pages.length);
    const spinePt = mmToPoints(spineMm);
    const totalTrimW = panelW * 2 + spinePt;
    const totalTrimH = panelH;

    const coverBuf = await resolveImageBuffer(
      story.id,
      story.coverFilename,
      story.demoCoverPath,
      resolver,
    );
    const coverImage = coverBuf ? await embedBufferAsPdfImage(pdfDoc, coverBuf) : null;

    addFramedBookPage(
      pdfDoc,
      totalTrimW,
      totalTrimH,
      bleedPt,
      slugPt,
      cropMarks,
      (page, bleedBox) => {
        const leftWidth = bleedPt + panelW + spinePt;
        page.drawRectangle({
          x: bleedBox.x,
          y: bleedBox.y,
          width: leftWidth,
          height: bleedBox.height,
          color: COLOR_PAPER_ALT,
        });
        page.drawRectangle({
          x: bleedBox.x + leftWidth,
          y: bleedBox.y,
          width: bleedBox.width - leftWidth,
          height: bleedBox.height,
          color: COLOR_PAPER,
        });
      },
      (page) => {
        // Left panel: Back Cover [0..panelW]
        renderBackCover(page, story, fonts, format);

        // Center panel: Spine [panelW..panelW+spinePt]
        page.pushOperators(pushGraphicsState(), translate(panelW, 0));
        renderSpinePanel(page, story, fonts, spinePt, panelH);
        page.pushOperators(popGraphicsState());

        // Right panel: Front Cover [panelW+spinePt..2*panelW+spinePt]
        page.pushOperators(pushGraphicsState(), translate(panelW + spinePt, 0));
        renderFrontCover(page, story, fonts, coverImage, format);
        page.pushOperators(popGraphicsState());
      },
      [panelW, panelW + spinePt],
    );

    return pdfDoc.save();
  }

  // 1. Front Cover (combined mode only)
  if (layoutMode === 'combined') {
    const coverBuf = await resolveImageBuffer(
      story.id,
      story.coverFilename,
      story.demoCoverPath,
      resolver,
    );
    const coverImage = coverBuf ? await embedBufferAsPdfImage(pdfDoc, coverBuf) : null;
    addFramedBookPage(
      pdfDoc,
      panelW,
      panelH,
      bleedPt,
      slugPt,
      cropMarks,
      COLOR_PAPER,
      (page) => {
        renderFrontCover(page, story, fonts, coverImage, format);
      },
    );
  }

  // 2. Dedication Page with Framed Child Photo
  const firstPhotoName = story.referencePhotos[0] ?? null;
  const photoBuf = firstPhotoName
    ? await resolveImageBuffer(story.id, firstPhotoName, null, resolver)
    : null;
  const childPhoto = photoBuf ? await embedBufferAsPdfImage(pdfDoc, photoBuf) : null;
  addFramedBookPage(
    pdfDoc,
    panelW,
    panelH,
    bleedPt,
    slugPt,
    cropMarks,
    COLOR_PAPER,
    (page) => {
      renderDedicationPage(page, story, fonts, childPhoto, format);
    },
  );

  // 3. Story Pages 1..N
  const sortedPages = [...story.pages].sort((a, b) => a.pageNumber - b.pageNumber);
  for (const storyPage of sortedPages) {
    const pageBuf = await resolveImageBuffer(
      story.id,
      storyPage.imageFilename,
      storyPage.demoAssetPath,
      resolver,
    );
    const pageImage = pageBuf ? await embedBufferAsPdfImage(pdfDoc, pageBuf) : null;
    addFramedBookPage(
      pdfDoc,
      panelW,
      panelH,
      bleedPt,
      slugPt,
      cropMarks,
      COLOR_PAPER,
      (page) => {
        renderStoryPage(page, storyPage, sortedPages.length, fonts, pageImage, format);
      },
    );
  }

  // 3b. Optional print-binding endpapers so total PDF page count is divisible by 4
  if (padToMultipleOf4) {
    const baseTotal =
      layoutMode === 'interior'
        ? sortedPages.length + 1 // dedication + pages
        : sortedPages.length + 3; // front cover + dedication + pages + back cover
    const paddingCount = (4 - (baseTotal % 4)) % 4;
    for (let i = 0; i < paddingCount; i += 1) {
      addFramedBookPage(
        pdfDoc,
        panelW,
        panelH,
        bleedPt,
        slugPt,
        cropMarks,
        COLOR_PAPER,
        (page) => {
          renderEndpaperPage(page, story, fonts, format);
        },
      );
    }
  }

  // 4. Back Cover (combined mode only)
  if (layoutMode === 'combined') {
    addFramedBookPage(
      pdfDoc,
      panelW,
      panelH,
      bleedPt,
      slugPt,
      cropMarks,
      COLOR_PAPER_ALT,
      (page) => {
        renderBackCover(page, story, fonts, format);
      },
    );
  }

  return pdfDoc.save();
}
