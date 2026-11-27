import { z } from 'zod';
import type { BookFormat } from '@/lib/types/story';

// =============================================================================
// Browser-Safe Shared PDF Layout Specification & Prepress Geometry Helpers
// Single source of truth consumed by src/lib/pdf/generator.ts and
// src/lib/preflight/checker.ts. Must NEVER import node:*, pdf-lib, or sharp.
// =============================================================================

export const PT_PER_INCH = 72;
export const PT_PER_MM = PT_PER_INCH / 25.4;

export function mmToPoints(mm: number): number {
  return mm * PT_PER_MM;
}

export const PDF_LAYOUT_MODES = ['combined', 'interior', 'cover-wrap'] as const;
export const PdfLayoutModeSchema = z.enum(PDF_LAYOUT_MODES);
export type PdfLayoutMode = z.infer<typeof PdfLayoutModeSchema>;

export const MIN_BLEED_MM = 0;
export const MAX_BLEED_MM = 10;
export const DEFAULT_CROP_MARK_SLUG_MM = 8; // >= 6 mm strictly outside BleedBox
export const MIN_SPINE_MM = 3;
export const MAX_SPINE_MM = 50;

export interface ArtworkBoxSpec {
  widthPt: number;
  heightPt: number;
}

export interface FormatLayoutSpec {
  label: string;
  trimWidthPt: number;
  trimHeightPt: number;
  coverArt: ArtworkBoxSpec;
  pageArt: ArtworkBoxSpec;
  dedicationPortrait: ArtworkBoxSpec;
  maxBodyLinesPerPage: number;
  approxCharsPerLine: number;
  cropMarkSlugMm: number;
}

export const FORMAT_LAYOUT_SPECS: Readonly<Record<BookFormat, FormatLayoutSpec>> = {
  square: {
    label: 'Kwadrat 21×21 cm',
    trimWidthPt: 595.28, // 210 mm
    trimHeightPt: 595.28, // 210 mm
    coverArt: { widthPt: 471.28, heightPt: 304 },
    pageArt: { widthPt: 511.28, heightPt: 312 },
    dedicationPortrait: { widthPt: 186, heightPt: 186 },
    maxBodyLinesPerPage: 8,
    approxCharsPerLine: 88,
    cropMarkSlugMm: DEFAULT_CROP_MARK_SLUG_MM,
  },
  'a4-landscape': {
    label: 'A4 poziomy',
    trimWidthPt: 841.89, // 297 mm
    trimHeightPt: 595.28, // 210 mm
    coverArt: { widthPt: 437.78, heightPt: 519.28 },
    pageArt: { widthPt: 432, heightPt: 507.28 },
    dedicationPortrait: { widthPt: 210, heightPt: 210 },
    maxBodyLinesPerPage: 19,
    approxCharsPerLine: 50,
    cropMarkSlugMm: DEFAULT_CROP_MARK_SLUG_MM,
  },
};

export function getFormatLayoutSpec(format: BookFormat): FormatLayoutSpec {
  return FORMAT_LAYOUT_SPECS[format];
}

/**
 * Estimates a safe default spine width (in mm) for POD 'cover-wrap' spreads
 * based on interior page count (dedication + story pages), rounded to 0.5 mm
 * and clamped to [6, MAX_SPINE_MM].
 */
export function computeDefaultSpineMm(storyPageCount: number): number {
  const interiorPages = Math.max(1, Math.floor(storyPageCount)) + 1;
  const rawMm = 5 + interiorPages * 0.18;
  const rounded = Math.round(rawMm * 2) / 2;
  return Math.min(MAX_SPINE_MM, Math.max(6, rounded));
}

export interface PdfBoxRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PrepressBoxes {
  mediaBox: PdfBoxRect;
  bleedBox: PdfBoxRect;
  trimBox: PdfBoxRect;
  offsetPt: number;
}

/**
 * Computes nested PDF prepress page boxes:
 * - MediaBox: [0, 0, trimW + 2*bleed + 2*slug, trimH + 2*bleed + 2*slug]
 * - BleedBox: [slug, slug, trimW + 2*bleed, trimH + 2*bleed]
 * - TrimBox:  [slug + bleed, slug + bleed, trimW, trimH]
 */
export function computePrepressBoxes(
  trimW: number,
  trimH: number,
  bleedPt: number,
  slugPt: number,
): PrepressBoxes {
  const safeBleed = Math.max(0, bleedPt);
  const safeSlug = Math.max(0, slugPt);
  const bleedW = trimW + safeBleed * 2;
  const bleedH = trimH + safeBleed * 2;
  const mediaW = bleedW + safeSlug * 2;
  const mediaH = bleedH + safeSlug * 2;
  const offsetPt = safeSlug + safeBleed;

  return {
    mediaBox: { x: 0, y: 0, width: mediaW, height: mediaH },
    bleedBox: { x: safeSlug, y: safeSlug, width: bleedW, height: bleedH },
    trimBox: { x: offsetPt, y: offsetPt, width: trimW, height: trimH },
    offsetPt,
  };
}

export interface CropMarkSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  kind: 'trim' | 'fold';
}

/**
 * Computes corner trim marks (and optional spine fold marks) strictly OUTSIDE
 * BleedBox and strictly INSIDE MediaBox, aligned to TrimBox edges.
 */
export function computeCropMarkSegments(
  trimW: number,
  trimH: number,
  bleedPt: number,
  slugPt: number,
  foldOffsetsX: readonly number[] = [],
): CropMarkSegment[] {
  if (slugPt <= 0) {
    return [];
  }

  const { mediaBox, bleedBox, trimBox } = computePrepressBoxes(trimW, trimH, bleedPt, slugPt);
  const bleedGapPt = Math.min(mmToPoints(1.5), slugPt * 0.35);
  const outerMarginPt = Math.min(mmToPoints(1.0), slugPt * 0.2);

  const bleedLeft = bleedBox.x;
  const bleedRight = bleedBox.x + bleedBox.width;
  const bleedBottom = bleedBox.y;
  const bleedTop = bleedBox.y + bleedBox.height;

  const trimLeft = trimBox.x;
  const trimRight = trimBox.x + trimBox.width;
  const trimBottom = trimBox.y;
  const trimTop = trimBox.y + trimBox.height;

  const leftMarkStart = outerMarginPt;
  const leftMarkEnd = bleedLeft - bleedGapPt;
  const rightMarkStart = bleedRight + bleedGapPt;
  const rightMarkEnd = mediaBox.width - outerMarginPt;

  const bottomMarkStart = outerMarginPt;
  const bottomMarkEnd = bleedBottom - bleedGapPt;
  const topMarkStart = bleedTop + bleedGapPt;
  const topMarkEnd = mediaBox.height - outerMarginPt;

  const segments: CropMarkSegment[] = [
    // Left horizontal trim ticks (bottom & top)
    { x1: leftMarkStart, y1: trimBottom, x2: leftMarkEnd, y2: trimBottom, kind: 'trim' },
    { x1: leftMarkStart, y1: trimTop, x2: leftMarkEnd, y2: trimTop, kind: 'trim' },
    // Right horizontal trim ticks (bottom & top)
    { x1: rightMarkStart, y1: trimBottom, x2: rightMarkEnd, y2: trimBottom, kind: 'trim' },
    { x1: rightMarkStart, y1: trimTop, x2: rightMarkEnd, y2: trimTop, kind: 'trim' },
    // Bottom vertical trim ticks (left & right)
    { x1: trimLeft, y1: bottomMarkStart, x2: trimLeft, y2: bottomMarkEnd, kind: 'trim' },
    { x1: trimRight, y1: bottomMarkStart, x2: trimRight, y2: bottomMarkEnd, kind: 'trim' },
    // Top vertical trim ticks (left & right)
    { x1: trimLeft, y1: topMarkStart, x2: trimLeft, y2: topMarkEnd, kind: 'trim' },
    { x1: trimRight, y1: topMarkStart, x2: trimRight, y2: topMarkEnd, kind: 'trim' },
  ];

  // Optional vertical spine fold ticks for cover-wrap spreads
  for (const fx of foldOffsetsX) {
    if (!Number.isFinite(fx) || fx <= 0 || fx >= trimW) {
      continue;
    }
    const x = trimLeft + fx;
    segments.push(
      { x1: x, y1: bottomMarkStart, x2: x, y2: bottomMarkEnd, kind: 'fold' },
      { x1: x, y1: topMarkStart, x2: x, y2: topMarkEnd, kind: 'fold' },
    );
  }

  return segments;
}

// =============================================================================
// Shared Font Glyph Encodability & Polish Line-Wrap Budget Helpers
// =============================================================================

export const POLISH_ORPHANS: ReadonlySet<string> = new Set([
  'a',
  'i',
  'o',
  'u',
  'w',
  'z',
  'A',
  'I',
  'O',
  'U',
  'W',
  'Z',
]);

// 17 typography punctuation/symbol codepoints verified present in both bundled
// Lora-Regular.ttf and PlusJakartaSans-Regular.ttf.
const PDF_SAFE_EXTRA_CODEPOINTS: ReadonlySet<number> = new Set([
  0x2013, // – EN DASH
  0x2014, // — EM DASH
  0x2018, // ‘ LEFT SINGLE QUOTATION MARK
  0x2019, // ’ RIGHT SINGLE QUOTATION MARK
  0x201a, // ‚ SINGLE LOW-9 QUOTATION MARK
  0x201c, // “ LEFT DOUBLE QUOTATION MARK
  0x201d, // ” RIGHT DOUBLE QUOTATION MARK
  0x201e, // „ DOUBLE LOW-9 QUOTATION MARK
  0x2020, // † DAGGER
  0x2021, // ‡ DOUBLE DAGGER
  0x2022, // • BULLET
  0x2026, // … HORIZONTAL ELLIPSIS
  0x2030, // ‰ PER MILLE SIGN
  0x2039, // ‹ SINGLE LEFT-POINTING ANGLE QUOTATION MARK
  0x203a, // › SINGLE RIGHT-POINTING ANGLE QUOTATION MARK
  0x20ac, // € EURO SIGN
  0x2122, // ™ TRADE MARK SIGN
]);

/**
 * Checks whether a Unicode codepoint is reliably renderable by the bundled
 * Polish editorial PDF fonts (Lora + Plus Jakarta Sans) without producing
 * `.notdef` tofu boxes.
 */
export function isPdfEncodableCodePoint(code: number): boolean {
  if (code === 0x09 || code === 0x0a || code === 0x0d || code === 0x00a0) {
    return true;
  }
  if (code >= 0x0020 && code <= 0x007e) {
    return true; // Printable ASCII
  }
  if (code >= 0x00a1 && code <= 0x00ff) {
    return true; // Latin-1 Supplement
  }
  if (code >= 0x0100 && code <= 0x017f) {
    return true; // Latin Extended-A (full Polish diacritic set)
  }
  return PDF_SAFE_EXTRA_CODEPOINTS.has(code);
}

/**
 * Returns unique characters/symbols in `raw` that cannot be reliably encoded
 * by the bundled PDF fonts (e.g. emojis ✨🦊, CJK, private-use or control
 * chars) and will be stripped during PDF generation.
 */
export function findUnencodablePdfGlyphs(raw: string): string[] {
  const normalized = raw
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200B-\u200F\uFEFF\uFE0E\uFE0F]/g, '');

  const unsupported = new Set<string>();
  for (const ch of normalized) {
    const code = ch.codePointAt(0);
    if (code === undefined) {
      continue;
    }
    if (!isPdfEncodableCodePoint(code)) {
      if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
        unsupported.add(`U+${code.toString(16).toUpperCase().padStart(4, '0')}`);
      } else {
        unsupported.add(ch);
      }
    }
  }
  return Array.from(unsupported);
}

/**
 * Estimates wrapped PDF body line count matching generator.ts's Polish orphan
 * gluing ("a", "i", "o", "u", "w", "z"), paragraph spacing, and long-word
 * breaking, without requiring PDFFont metrics.
 */
export function estimateWrappedLineCount(
  rawText: string,
  approxCharsPerLine: number,
): number {
  const maxChars = Math.max(1, Math.floor(approxCharsPerLine));
  const normalized = rawText
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200B-\u200F\uFEFF\uFE0E\uFE0F]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\t/g, ' ');

  const paragraphs = normalized.split('\n');
  let lineCount = 0;

  for (let pIndex = 0; pIndex < paragraphs.length; pIndex += 1) {
    const paragraph = paragraphs[pIndex].trim();
    if (!paragraph) {
      if (pIndex > 0 && pIndex < paragraphs.length - 1 && lineCount > 0) {
        lineCount += 1; // Blank paragraph spacer line
      }
      continue;
    }

    const rawWords = paragraph.split(/\s+/).filter(Boolean);
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

    let currentLen = 0;
    for (const token of tokens) {
      const candidateLen = currentLen > 0 ? currentLen + 1 + token.length : token.length;
      if (candidateLen <= maxChars) {
        currentLen = candidateLen;
        continue;
      }

      if (currentLen > 0) {
        lineCount += 1;
        currentLen = 0;
      }

      if (token.length <= maxChars) {
        currentLen = token.length;
      } else {
        const subWords = token.split(' ');
        for (const sub of subWords) {
          if (sub.length <= maxChars) {
            if (currentLen === 0) {
              currentLen = sub.length;
            } else if (currentLen + 1 + sub.length <= maxChars) {
              currentLen += 1 + sub.length;
            } else {
              lineCount += 1;
              currentLen = sub.length;
            }
          } else {
            if (currentLen > 0) {
              lineCount += 1;
              currentLen = 0;
            }
            const fullLines = Math.floor(sub.length / maxChars);
            const remainder = sub.length % maxChars;
            if (remainder === 0) {
              lineCount += Math.max(0, fullLines - 1);
              currentLen = maxChars;
            } else {
              lineCount += fullLines;
              currentLen = remainder;
            }
          }
        }
      }
    }

    if (currentLen > 0) {
      lineCount += 1;
    }
  }

  return lineCount;
}
