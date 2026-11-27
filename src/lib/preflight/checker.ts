import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import {
  PT_PER_INCH,
  estimateWrappedLineCount,
  findUnencodablePdfGlyphs,
  getFormatLayoutSpec,
  type ArtworkBoxSpec,
} from '@/lib/pdf/layout-spec';
import { declinePolishName } from '@/lib/polish/inflection';
import { resolveSafeChildPath } from '@/lib/storage/security';
import { readStoryAsset } from '@/lib/storage/store';
import {
  BookFormatSchema,
  DEMO_ASSET_PATH_REGEX,
  type BookFormat,
  type ChildGender,
  type StoryRecord,
} from '@/lib/types/story';

// =============================================================================
// Deterministic Print Pre-Flight Engine
// Checks structural completeness, artwork decodability & effective DPI,
// aspect ratio safety, Polish text integrity, and bookbinding sheet padding.
// =============================================================================

export const PREFLIGHT_SEVERITIES = ['error', 'warning', 'info'] as const;
export const PreflightSeveritySchema = z.enum(PREFLIGHT_SEVERITIES);
export type PreflightSeverity = z.infer<typeof PreflightSeveritySchema>;

export const PreflightIssueSchema = z.object({
  code: z.string().min(1),
  severity: PreflightSeveritySchema,
  slot: z.union([
    z.literal('book'),
    z.literal('cover'),
    z.literal('dedication'),
    z.literal('back-cover'),
    z.number().int().min(1).max(12),
  ]),
  message: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
});

export type PreflightIssue = z.infer<typeof PreflightIssueSchema>;

export const PreflightReportSchema = z.object({
  storyId: z.string().min(1),
  format: BookFormatSchema,
  checkedAt: z.iso.datetime({ offset: true }),
  readyForPrint: z.boolean(),
  score: z.number().int().min(0).max(100),
  summary: z.object({
    errors: z.number().int().min(0),
    warnings: z.number().int().min(0),
    info: z.number().int().min(0),
  }),
  metrics: z.object({
    storyPages: z.number().int().min(0),
    totalPdfPages: z.number().int().min(0),
    paddingNeededForMultipleOf4: z.number().int().min(0).max(3),
    expectedArtworkSlots: z.number().int().min(1),
    readyArtworkSlots: z.number().int().min(0),
    minEffectiveDpi: z.number().nullable(),
  }),
  issues: z.array(PreflightIssueSchema),
});

export type PreflightReport = z.infer<typeof PreflightReportSchema>;

export interface PreflightAssetResolver {
  readStoryAsset(storyId: string, filename: string): Promise<Buffer | null>;
}

export interface PreflightOptions {
  /** Minimum blocking DPI below which printing is rejected (default: 100). */
  minBlockingDpi?: number;
  /** Recommended print-grade DPI below which a warning is emitted (default: 240). */
  recommendedPrintDpi?: number;
  /** Maximum tolerable aspect ratio multiplier before crop warning (default: 2.2). */
  maxAspectRatioMismatch?: number;
}

const PLACEHOLDER_REGEX =
  /\{\{[^}]+\}\}|\[\[[^\]]+\]\]|\b(?:TODO|FIXME|TBD)\b|\b(?:undefined|NaN)\b/i;

const UNICODE_FORMAT_CHARS_REGEX = /\p{Cf}/gu;

const defaultResolver: PreflightAssetResolver = {
  async readStoryAsset(storyId: string, filename: string): Promise<Buffer | null> {
    const asset = await readStoryAsset(storyId, filename);
    return asset ? asset.buffer : null;
  },
};

async function safeReadStoryAsset(
  storyId: string,
  filename: string,
  resolver: PreflightAssetResolver,
): Promise<Buffer | null> {
  try {
    const buf = await resolver.readStoryAsset(storyId, filename);
    return buf && buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

async function resolveArtworkBuffer(
  storyId: string,
  filename: string | null,
  demoAssetPath: string | null | undefined,
  resolver: PreflightAssetResolver,
): Promise<Buffer | null> {
  if (filename) {
    const buf = await safeReadStoryAsset(storyId, filename, resolver);
    if (buf) return buf;
  }

  if (demoAssetPath && DEMO_ASSET_PATH_REGEX.test(demoAssetPath)) {
    try {
      const publicRoot = path.join(process.cwd(), 'public');
      const relativeSegments = demoAssetPath.replace(/^\/+/, '').split('/');
      const demoPath = resolveSafeChildPath(publicRoot, ...relativeSegments);
      const buf = await fs.readFile(demoPath);
      return buf.length > 0 ? buf : null;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Verifies both header metadata and actual pixel decodability via sharp so
 * truncated or corrupted image payloads are reliably caught before PDF export.
 */
async function inspectImageBuffer(
  buffer: Buffer,
): Promise<{ ok: true; width: number; height: number } | { ok: false; reason: 'decode' | 'dimensions' }> {
  try {
    const meta = await sharp(buffer).metadata();
    if (!meta.width || !meta.height || meta.width <= 0 || meta.height <= 0) {
      return { ok: false, reason: 'dimensions' };
    }
    // Decode actual pixels at tiny scale to detect truncated/corrupted bitstreams
    await sharp(buffer).resize(8, 8, { fit: 'inside' }).raw().toBuffer();
    return { ok: true, width: meta.width, height: meta.height };
  } catch {
    return { ok: false, reason: 'decode' };
  }
}

/**
 * Computes effective DPI when an image of (imgW x imgH) is fitted via CSS/PDF
 * object-fit: cover into a physical slot of (boxWPt x boxHPt) points.
 */
function computeCoverEffectiveDpi(
  imgW: number,
  imgH: number,
  boxWPt: number,
  boxHPt: number,
): { effectiveDpi: number; aspectMismatch: number } {
  const boxWIn = boxWPt / PT_PER_INCH;
  const boxHIn = boxHPt / PT_PER_INCH;
  const imgAspect = imgW / imgH;
  const boxAspect = boxWPt / boxHPt;

  // Under cover fit, the limiting axis determines the scale factor.
  const drawnWIn = imgAspect > boxAspect ? boxHIn * imgAspect : boxWIn;
  const drawnHIn = imgAspect > boxAspect ? boxHIn : boxWIn / imgAspect;

  const dpiX = imgW / drawnWIn;
  const dpiY = imgH / drawnHIn;
  const effectiveDpi = Math.round(Math.min(dpiX, dpiY));
  const aspectMismatch = Math.max(imgAspect / boxAspect, boxAspect / imgAspect);

  return {
    effectiveDpi,
    aspectMismatch: Number(aspectMismatch.toFixed(2)),
  };
}

// =============================================================================
// Polish 7-Case Word-Boundary Child Name Matcher
// =============================================================================

const POLISH_CASE_KEYS = ['nom', 'gen', 'dat', 'acc', 'ins', 'loc', 'voc'] as const;
type PolishCaseKey = (typeof POLISH_CASE_KEYS)[number];
type FullPolishNameCases = Record<PolishCaseKey, string>;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function deriveTokenCases(token: string, gender: ChildGender): FullPolishNameCases {
  const declined = declinePolishName(token, gender);
  const nom = declined.nominative.normalize('NFC').toLocaleLowerCase('pl-PL');
  const gen = declined.genitive.normalize('NFC').toLocaleLowerCase('pl-PL');
  const voc = declined.vocative.normalize('NFC').toLocaleLowerCase('pl-PL');

  // Feminine -a pattern (and masculine -a nouns like Kuba, Barnaba)
  if (
    (gender === 'girl' && nom.endsWith('a')) ||
    (gender === 'boy' && nom.endsWith('a') && gen !== nom)
  ) {
    const stem = nom.slice(0, -1);
    const acc = `${stem}ę`;
    const ins = `${stem}ą`;

    let datLoc = gen;
    if (nom.endsWith('ka')) {
      datLoc = `${nom.slice(0, -2)}ce`;
    } else if (nom.endsWith('ga')) {
      datLoc = `${nom.slice(0, -2)}dze`;
    } else if (nom.endsWith('cha')) {
      datLoc = `${nom.slice(0, -3)}sze`;
    } else if (nom.endsWith('ra')) {
      datLoc = `${nom.slice(0, -2)}rze`;
    } else if (nom.endsWith('ta')) {
      datLoc = `${nom.slice(0, -2)}cie`;
    } else if (nom.endsWith('da')) {
      datLoc = `${nom.slice(0, -2)}dzie`;
    } else if (gen.endsWith('y') && !/(?:c|dz|sz|cz|rz|ż)a$/.test(nom)) {
      datLoc = `${stem}ie`;
    }

    return { nom, gen, dat: datLoc, acc, ins, loc: datLoc, voc };
  }

  // Masculine adjectival pattern (Antoni -> Antoniego, Ignacy -> Ignacego)
  if (gender === 'boy' && gen.endsWith('ego')) {
    const adjStem = gen.slice(0, -3);
    const dat = `${adjStem}emu`;
    const ins = adjStem.endsWith('i') ? `${adjStem}m` : `${adjStem}ym`;
    return { nom, gen, dat, acc: gen, ins, loc: ins, voc };
  }

  // Standard masculine -a genitive pattern (Jan -> Jana, Paweł -> Pawła, Antoś -> Antosia)
  if (gender === 'boy' && gen !== nom && gen.endsWith('a')) {
    const gStem = gen.slice(0, -1);
    const dat = `${gStem}owi`;
    const ins = /[kg]$/.test(gStem) ? `${gStem}iem` : `${gStem}em`;
    return { nom, gen, dat, acc: gen, ins, loc: voc, voc };
  }

  // Foreign / indeclinable fallback
  return { nom, gen, dat: nom, acc: nom, ins: nom, loc: voc, voc };
}

function buildChildNameRegexPatterns(childName: string, gender: ChildGender): string[] {
  const clean = childName
    .replace(UNICODE_FORMAT_CHARS_REGEX, '')
    .trim()
    .replace(/\s+/g, ' ')
    .normalize('NFC');

  if (clean.length === 0) {
    return [];
  }

  const patterns = new Set<string>();

  // Include direct declinePolishName outputs for the full phrase
  const direct = declinePolishName(clean, gender);
  for (const form of [direct.nominative, direct.vocative, direct.genitive]) {
    const normalized = form.normalize('NFC').toLocaleLowerCase('pl-PL').trim();
    if (normalized.length > 0) {
      patterns.add(
        normalized
          .split(/\s+/)
          .map((part) => escapeRegExp(part))
          .join('\\s+'),
      );
    }
  }

  // Compose case-by-case patterns across multi-word & hyphenated names
  const spaceWords = clean.split(' ').filter(Boolean);
  const wordCaseMaps = spaceWords.map((word) => {
    const hyphenParts = word.split('-').filter(Boolean);
    if (hyphenParts.length > 1) {
      const partCases = hyphenParts.map((part) => deriveTokenCases(part, gender));
      const combined = {} as FullPolishNameCases;
      for (const caseKey of POLISH_CASE_KEYS) {
        combined[caseKey] = partCases.map((c) => escapeRegExp(c[caseKey])).join('-');
      }
      return combined;
    }

    const single = deriveTokenCases(word, gender);
    const escaped = {} as FullPolishNameCases;
    for (const caseKey of POLISH_CASE_KEYS) {
      escaped[caseKey] = escapeRegExp(single[caseKey]);
    }
    return escaped;
  });

  for (const caseKey of POLISH_CASE_KEYS) {
    const phrasePattern = wordCaseMaps.map((m) => m[caseKey]).join('\\s+');
    if (phrasePattern.length > 0) {
      patterns.add(phrasePattern);
    }
  }

  return Array.from(patterns);
}

function storyContainsChildName(
  fullStoryText: string,
  childName: string,
  gender: ChildGender,
): boolean {
  const variants = buildChildNameRegexPatterns(childName, gender);
  if (variants.length === 0) {
    return true;
  }

  const normalizedText = fullStoryText.normalize('NFC').toLocaleLowerCase('pl-PL');
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${variants.join('|')})(?![\\p{L}\\p{N}])`,
    'u',
  );
  return pattern.test(normalizedText);
}

export async function runStoryPreflight(
  story: StoryRecord,
  format: BookFormat = story.bookFormat,
  resolver: PreflightAssetResolver = defaultResolver,
  options: PreflightOptions = {},
): Promise<PreflightReport> {
  const minBlockingDpi = options.minBlockingDpi ?? 100;
  const recommendedPrintDpi = options.recommendedPrintDpi ?? 240;
  const maxAspectRatioMismatch = options.maxAspectRatioMismatch ?? 2.2;
  const layoutSpec = getFormatLayoutSpec(format);

  const issues: PreflightIssue[] = [];

  // 1. Generation stage check
  if (story.generationStage !== 'complete') {
    issues.push({
      code: 'STORY_INCOMPLETE_STAGE',
      severity: 'error',
      slot: 'book',
      message: `Bajka nie jest jeszcze ukończona (etap: ${story.generationStage}). Wygeneruj brakujące strony przed wysłaniem do druku.`,
      details: { generationStage: story.generationStage },
    });
  }

  // 2. Bookbinding multiple-of-4 check (cover + dedication + N pages + back cover)
  const totalPdfPages = story.pages.length + 3;
  const paddingNeededForMultipleOf4 = (4 - (totalPdfPages % 4)) % 4;
  if (paddingNeededForMultipleOf4 > 0) {
    issues.push({
      code: 'PAGE_COUNT_PADDING_RECOMMENDED',
      severity: 'info',
      slot: 'book',
      message: `Książka ma obecnie ${totalPdfPages} stron PDF. Dla druku w oprawie szytej/zeszytowej zalecane jest dopełnienie o ${paddingNeededForMultipleOf4} str. (parametr padToMultipleOf4=true).`,
      details: {
        totalPdfPages,
        paddingNeededForMultipleOf4,
        paddedTotalPages: totalPdfPages + paddingNeededForMultipleOf4,
      },
    });
  }

  // 3. Text integrity checks (placeholders, lengths, line overflow, glyphs, child name presence)
  const textFields: Array<{
    slot: PreflightIssue['slot'];
    label: string;
    value: string;
    minLen?: number;
    maxLen?: number;
    useBodyLineBudget?: boolean;
  }> = [
    { slot: 'cover', label: 'Tytuł okładki', value: story.title, minLen: 2, maxLen: 120 },
    { slot: 'cover', label: 'Podtytuł okładki', value: story.subtitle, minLen: 2, maxLen: 200 },
    {
      slot: 'dedication',
      label: 'Dedykacja',
      value: story.dedicationText,
      minLen: 10,
      maxLen: 900,
    },
    {
      slot: 'back-cover',
      label: 'Opis na tylnej okładce',
      value: story.backCoverBlurb,
      minLen: 10,
      maxLen: 900,
    },
  ];

  const sortedPages = [...story.pages].sort((a, b) => a.pageNumber - b.pageNumber);
  for (const page of sortedPages) {
    textFields.push({
      slot: page.pageNumber,
      label: `Strona ${page.pageNumber} (tytuł rozdziału)`,
      value: page.chapterTitle,
      minLen: 2,
      maxLen: 120,
    });
    textFields.push({
      slot: page.pageNumber,
      label: `Strona ${page.pageNumber} (treść)`,
      value: page.text,
      minLen: 20,
      useBodyLineBudget: true,
    });
  }

  for (const field of textFields) {
    const trimmed = field.value.trim();
    if (PLACEHOLDER_REGEX.test(trimmed)) {
      issues.push({
        code: 'UNRESOLVED_PLACEHOLDER',
        severity: 'error',
        slot: field.slot,
        message: `${field.label} zawiera nieuzupełniony znacznik szablonu lub tekst techniczny.`,
        details: { field: field.label },
      });
    }
    if (field.minLen !== undefined && trimmed.length < field.minLen) {
      issues.push({
        code: 'TEXT_TOO_SHORT',
        severity: 'warning',
        slot: field.slot,
        message: `${field.label} jest bardzo krótki (${trimmed.length} zn.). Sprawdź, czy treść jest kompletna.`,
        details: { field: field.label, length: trimmed.length, minRecommended: field.minLen },
      });
    }
    if (field.useBodyLineBudget) {
      const estimatedLines = estimateWrappedLineCount(trimmed, layoutSpec.approxCharsPerLine);
      if (estimatedLines > layoutSpec.maxBodyLinesPerPage) {
        issues.push({
          code: 'TEXT_OVERFLOW_RISK',
          severity: 'warning',
          slot: field.slot,
          message: `${field.label} zajmuje szacunkowo ${estimatedLines} linii (limit formatu ${format}: ${layoutSpec.maxBodyLinesPerPage}) i może zostać przycięty w składzie PDF.`,
          details: {
            field: field.label,
            length: trimmed.length,
            estimatedLines,
            maxBodyLinesPerPage: layoutSpec.maxBodyLinesPerPage,
            approxCharsPerLine: layoutSpec.approxCharsPerLine,
          },
        });
      }
    } else if (field.maxLen !== undefined && trimmed.length > field.maxLen) {
      issues.push({
        code: 'TEXT_OVERFLOW_RISK',
        severity: 'warning',
        slot: field.slot,
        message: `${field.label} ma ${trimmed.length} znaków i może zostać przycięty w składzie PDF.`,
        details: { field: field.label, length: trimmed.length, maxRecommended: field.maxLen },
      });
    }

    const unencodable = findUnencodablePdfGlyphs(field.value);
    if (unencodable.length > 0) {
      issues.push({
        code: 'UNENCODABLE_GLYPHS_WARNING',
        severity: 'warning',
        slot: field.slot,
        message: `${field.label} zawiera znaki nieobsługiwane przez czcionki PDF (${unencodable.slice(0, 5).join(' ')}) — zostaną pominięte w pliku do druku.`,
        details: {
          field: field.label,
          glyphs: unencodable.slice(0, 10),
          count: unencodable.length,
        },
      });
    }
  }

  const fullStoryText = [
    story.title,
    story.dedicationText,
    ...sortedPages.map((p) => p.text),
  ].join('\n');

  if (!storyContainsChildName(fullStoryText, story.input.childName, story.input.gender)) {
    issues.push({
      code: 'CHILD_NAME_NOT_FOUND',
      severity: 'warning',
      slot: 'book',
      message: `Imię bohatera („${story.input.childName}”) nie zostało wykryte w treści bajki.`,
      details: { childName: story.input.childName },
    });
  }

  // 4. Artwork availability, decodability, DPI & aspect ratio checks (cover + pages)
  const artworkChecks: Array<{
    slot: 'cover' | number;
    label: string;
    status: string;
    filename: string | null;
    demoPath: string | null | undefined;
    box: ArtworkBoxSpec;
  }> = [
    {
      slot: 'cover',
      label: 'Okładka',
      status: story.coverStatus,
      filename: story.coverFilename,
      demoPath: story.demoCoverPath,
      box: layoutSpec.coverArt,
    },
    ...sortedPages.map((p) => ({
      slot: p.pageNumber as 'cover' | number,
      label: `Strona ${p.pageNumber}`,
      status: p.imageStatus,
      filename: p.imageFilename,
      demoPath: p.demoAssetPath,
      box: layoutSpec.pageArt,
    })),
  ];

  let readyArtworkSlots = 0;
  let minEffectiveDpi: number | null = null;

  for (const check of artworkChecks) {
    const isStatusReady = check.status === 'ready' || check.status === 'custom-uploaded';
    if (!isStatusReady) {
      issues.push({
        code: check.status === 'error' ? 'ARTWORK_GENERATION_ERROR' : 'MISSING_ARTWORK',
        severity: 'error',
        slot: check.slot,
        message: `${check.label}: brak gotowej ilustracji (status: ${check.status}).`,
        details: { imageStatus: check.status },
      });
      continue;
    }

    const buffer = await resolveArtworkBuffer(
      story.id,
      check.filename,
      check.demoPath,
      resolver,
    );
    if (!buffer) {
      issues.push({
        code: 'ARTWORK_FILE_MISSING',
        severity: 'error',
        slot: check.slot,
        message: `${check.label}: plik ilustracji nie istnieje w magazynie zasobów.`,
        details: { filename: check.filename, demoPath: check.demoPath ?? null },
      });
      continue;
    }

    const inspected = await inspectImageBuffer(buffer);
    if (!inspected.ok) {
      issues.push({
        code: 'CORRUPT_IMAGE',
        severity: 'error',
        slot: check.slot,
        message:
          inspected.reason === 'dimensions'
            ? `${check.label}: obraz ma nieprawidłowe wymiary.`
            : `${check.label}: nie udało się odczytać pliku graficznego (uszkodzony obraz).`,
      });
      continue;
    }

    const { width, height } = inspected;
    readyArtworkSlots += 1;
    const { effectiveDpi, aspectMismatch } = computeCoverEffectiveDpi(
      width,
      height,
      check.box.widthPt,
      check.box.heightPt,
    );
    if (minEffectiveDpi === null || effectiveDpi < minEffectiveDpi) {
      minEffectiveDpi = effectiveDpi;
    }

    if (effectiveDpi < minBlockingDpi) {
      issues.push({
        code: 'LOW_IMAGE_RESOLUTION_BLOCKING',
        severity: 'error',
        slot: check.slot,
        message: `${check.label}: zbyt niska rozdzielczość do druku (${width}×${height} px, ~${effectiveDpi} DPI; wymagane min. ${minBlockingDpi} DPI).`,
        details: { width, height, effectiveDpi, minBlockingDpi },
      });
    } else if (effectiveDpi < recommendedPrintDpi) {
      issues.push({
        code: 'LOW_IMAGE_RESOLUTION_WARNING',
        severity: 'warning',
        slot: check.slot,
        message: `${check.label}: rozdzielczość ~${effectiveDpi} DPI (${width}×${height} px) jest poniżej zalecanych ${recommendedPrintDpi} DPI dla druku profesjonalnego.`,
        details: { width, height, effectiveDpi, recommendedPrintDpi },
      });
    }

    if (aspectMismatch > maxAspectRatioMismatch) {
      issues.push({
        code: 'EXTREME_ASPECT_RATIO_MISMATCH',
        severity: 'warning',
        slot: check.slot,
        message: `${check.label}: proporcje ilustracji (${width}×${height}) mocno odbiegają od kadru strony — istotna część obrazu zostanie przycięta.`,
        details: { width, height, aspectMismatch, maxAspectRatioMismatch },
      });
    }
  }

  // 5. Dedication reference photo check (story.referencePhotos[0])
  if (story.referencePhotos.length === 0) {
    issues.push({
      code: 'DEDICATION_PHOTO_ABSENT',
      severity: 'info',
      slot: 'dedication',
      message:
        'Brak zapisanego zdjęcia dziecka (lub zostało usunięte zgodnie z RODO) — strona dedykacji użyje ozdobnego monogramu.',
    });
  } else {
    const firstPhoto = story.referencePhotos[0];
    const photoBuffer = await safeReadStoryAsset(story.id, firstPhoto, resolver);
    if (!photoBuffer) {
      issues.push({
        code: 'DEDICATION_PHOTO_MISSING',
        severity: 'error',
        slot: 'dedication',
        message: 'Zdjęcie dziecka do dedykacji nie istnieje w magazynie zasobów.',
        details: { filename: firstPhoto },
      });
    } else {
      const inspected = await inspectImageBuffer(photoBuffer);
      if (!inspected.ok) {
        issues.push({
          code: 'CORRUPT_IMAGE',
          severity: 'error',
          slot: 'dedication',
          message:
            inspected.reason === 'dimensions'
              ? 'Zdjęcie dziecka do dedykacji ma nieprawidłowe wymiary.'
              : 'Zdjęcie dziecka do dedykacji jest uszkodzone i nie może zostać odczytane.',
          details: { filename: firstPhoto },
        });
      } else {
        const { width, height } = inspected;
        const { effectiveDpi, aspectMismatch } = computeCoverEffectiveDpi(
          width,
          height,
          layoutSpec.dedicationPortrait.widthPt,
          layoutSpec.dedicationPortrait.heightPt,
        );
        if (minEffectiveDpi === null || effectiveDpi < minEffectiveDpi) {
          minEffectiveDpi = effectiveDpi;
        }

        if (effectiveDpi < minBlockingDpi) {
          issues.push({
            code: 'LOW_IMAGE_RESOLUTION_BLOCKING',
            severity: 'error',
            slot: 'dedication',
            message: `Zdjęcie do dedykacji ma zbyt niską rozdzielczość do druku (${width}×${height} px, ~${effectiveDpi} DPI; wymagane min. ${minBlockingDpi} DPI).`,
            details: { filename: firstPhoto, width, height, effectiveDpi, minBlockingDpi },
          });
        } else if (effectiveDpi < recommendedPrintDpi) {
          issues.push({
            code: 'LOW_IMAGE_RESOLUTION_WARNING',
            severity: 'warning',
            slot: 'dedication',
            message: `Zdjęcie do dedykacji ma rozdzielczość ~${effectiveDpi} DPI (${width}×${height} px), poniżej zalecanych ${recommendedPrintDpi} DPI.`,
            details: { filename: firstPhoto, width, height, effectiveDpi, recommendedPrintDpi },
          });
        }

        if (aspectMismatch > maxAspectRatioMismatch) {
          issues.push({
            code: 'EXTREME_ASPECT_RATIO_MISMATCH',
            severity: 'warning',
            slot: 'dedication',
            message: `Proporcje zdjęcia do dedykacji (${width}×${height}) mocno odbiegają od kwadratowej ramki — istotna część portretu zostanie przycięta.`,
            details: {
              filename: firstPhoto,
              width,
              height,
              aspectMismatch,
              maxAspectRatioMismatch,
            },
          });
        }
      }
    }
  }

  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;
  const info = issues.filter((i) => i.severity === 'info').length;

  // Deterministic quality score: 100 - 25/error - 4/warning (clamped 0..100)
  const score = Math.max(0, Math.min(100, 100 - errors * 25 - warnings * 4));

  return {
    storyId: story.id,
    format,
    checkedAt: new Date().toISOString(),
    readyForPrint: errors === 0,
    score,
    summary: { errors, warnings, info },
    metrics: {
      storyPages: story.pages.length,
      totalPdfPages,
      paddingNeededForMultipleOf4,
      expectedArtworkSlots: artworkChecks.length,
      readyArtworkSlots,
      minEffectiveDpi,
    },
    issues,
  };
}
