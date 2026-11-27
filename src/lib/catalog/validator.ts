import sharp from 'sharp';
import { buildPolishStoryDraft } from '@/lib/polish/templates';
import { runStoryPreflight, type PreflightAssetResolver } from '@/lib/preflight/checker';
import type { StoryInput, StoryRecord } from '@/lib/types/story';
import {
  ThemeCatalogItemSchema,
  getAllThemes,
  isThemeActiveOnDate,
  type ThemeCatalogItem,
} from './themes';

// =============================================================================
// Editorial Quality Validator & Synthetic Dry-Run Preflight for Seasonal Themes
// =============================================================================

export interface CatalogValidationIssue {
  code: string;
  severity: 'error' | 'warning';
  field: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ThemeValidationResult {
  valid: boolean;
  theme?: ThemeCatalogItem;
  errors: CatalogValidationIssue[];
  warnings: CatalogValidationIssue[];
  dryRunPreflight?: {
    readyForPrint: boolean;
    score: number;
    errors: number;
    warnings: number;
  };
}

export interface CatalogAuditReport {
  valid: boolean;
  totalThemes: number;
  evergreenCount: number;
  seasonalCount: number;
  uncoveredDaysOfYear: number[];
  seasonalCoveragePercent: number;
  errors: CatalogValidationIssue[];
  warnings: CatalogValidationIssue[];
}

const PLACEHOLDER_REGEX = /\{\{[^}]*\}\}|\[\[[^\]]*\]\]|\b(?:TODO|FIXME|TBD|LOREM|IPSUM)\b/i;

let cachedSyntheticHiResPng: Promise<Buffer> | null = null;

async function getSyntheticHiResBuffer(): Promise<Buffer> {
  if (!cachedSyntheticHiResPng) {
    cachedSyntheticHiResPng = sharp({
      create: {
        width: 1800,
        height: 1200,
        channels: 3,
        background: { r: 222, g: 196, b: 162 },
      },
    })
      .png({ compressionLevel: 6 })
      .toBuffer();
  }
  return cachedSyntheticHiResPng;
}

export interface ValidateThemeProposalOptions {
  existingCatalog?: readonly ThemeCatalogItem[];
  allowExistingId?: boolean;
  runDryRunPreflight?: boolean;
}

export async function validateThemeProposal(
  rawCandidate: unknown,
  options: ValidateThemeProposalOptions = {},
): Promise<ThemeValidationResult> {
  const errors: CatalogValidationIssue[] = [];
  const warnings: CatalogValidationIssue[] = [];
  const existingCatalog = options.existingCatalog ?? getAllThemes();

  const parsed = ThemeCatalogItemSchema.safeParse(rawCandidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push({
        code: 'SCHEMA_VALIDATION_FAILED',
        severity: 'error',
        field: issue.path.map(String).join('.') || 'theme',
        message: issue.message,
      });
    }
  }

  // Also run semantic/editorial checks on raw object fields so multiple defects are reported together
  if (rawCandidate && typeof rawCandidate === 'object') {
    const obj = rawCandidate as Record<string, unknown>;

    if (typeof obj.id === 'string' && !options.allowExistingId) {
      if (existingCatalog.some((item) => item.id === obj.id)) {
        errors.push({
          code: 'DUPLICATE_THEME_ID',
          severity: 'error',
          field: 'id',
          message: `Motyw o identyfikatorze "${obj.id}" już istnieje w aktywnym katalogu.`,
        });
      }
    }

    if (typeof obj.label === 'string' && PLACEHOLDER_REGEX.test(obj.label)) {
      errors.push({
        code: 'UNRESOLVED_PLACEHOLDER',
        severity: 'error',
        field: 'label',
        message: 'Nazwa motywu (label) zawiera niedokończony znacznik lub tekst roboczy.',
      });
    }

    if (typeof obj.theme === 'string' && PLACEHOLDER_REGEX.test(obj.theme)) {
      errors.push({
        code: 'UNRESOLVED_PLACEHOLDER',
        severity: 'error',
        field: 'theme',
        message: 'Opis motywu (theme) zawiera niedokończony znacznik lub tekst roboczy.',
      });
    }
  }

  if (!parsed.success) {
    return { valid: false, errors, warnings };
  }

  const theme = parsed.data;

  // Editorial quality warnings
  if (theme.season !== 'evergreen' && !theme.activeWindow) {
    warnings.push({
      code: 'SEASONAL_MISSING_WINDOW',
      severity: 'warning',
      field: 'activeWindow',
      message: 'Motyw sezonowy nie ma zdefiniowanego okna dat (activeWindow) — będzie widoczny cały rok.',
    });
  }

  if (theme.season !== 'evergreen' && !theme.badge) {
    warnings.push({
      code: 'SEASONAL_MISSING_BADGE',
      severity: 'warning',
      field: 'badge',
      message: 'Motyw sezonowy nie posiada etykiety (badge) wyświetlanej w kreatorze.',
    });
  }

  if (theme.theme.length < 24) {
    warnings.push({
      code: 'THEME_DESCRIPTION_SHORT',
      severity: 'warning',
      field: 'theme',
      message: 'Opis motywu jest krótki (< 24 zn.) — bogatszy opis poprawia jakość generowanej fabuły.',
    });
  }

  if (theme.tags.length === 0) {
    warnings.push({
      code: 'MISSING_TAGS',
      severity: 'warning',
      field: 'tags',
      message: 'Dodaj co najmniej 1–3 tagi ułatwiające wyszukiwanie i planowanie kampanii.',
    });
  }

  if (errors.length > 0) {
    return { valid: false, theme, errors, warnings };
  }

  // Synthetic dry-run draft + deterministic preflight check
  let dryRunPreflight: ThemeValidationResult['dryRunPreflight'];
  if (options.runDryRunPreflight !== false) {
    const sampleAge = theme.ageRange
      ? Math.round((theme.ageRange.min + theme.ageRange.max) / 2)
      : 5;
    const sampleInput: StoryInput = {
      childName: 'Zosia',
      childAge: sampleAge,
      gender: 'girl',
      companion: 'rudy kotek Mruczek',
      theme: theme.theme,
      themeId: theme.id,
      artStyle: theme.suggestedArtStyle ?? 'watercolor',
      mood: theme.suggestedMood,
      pageCount: 10,
      dedicationFrom: 'Mama i Tata',
    };

    const draft = buildPolishStoryDraft(sampleInput);
    const nowIso = new Date().toISOString();
    const syntheticStory: StoryRecord = {
      id: `dryrun-${theme.id}`.slice(0, 60),
      createdAt: nowIso,
      updatedAt: nowIso,
      provider: 'demo',
      generationMode: 'full',
      generationStage: 'complete',
      bookFormat: 'square',
      input: sampleInput,
      title: draft.title,
      subtitle: draft.subtitle,
      dedicationText: draft.dedicationText,
      backCoverBlurb: draft.backCoverBlurb,
      characterBible: draft.characterBible,
      coverPrompt: draft.coverPrompt,
      coverFilename: 'cover.png',
      demoCoverPath: null,
      coverStatus: 'ready',
      referencePhotos: ['ref-1.png'],
      pages: draft.pages.map((p) => ({
        pageNumber: p.pageNumber,
        chapterTitle: p.chapterTitle,
        text: p.text,
        imagePrompt: p.imagePrompt,
        imageFilename: `page-${p.pageNumber}.png`,
        demoAssetPath: null,
        imageStatus: 'ready',
      })),
      modelsUsed: {
        textModel: 'demo-polish-storyteller-v1',
        imageModel: 'demo-watercolor-plates-v1',
      },
    };

    const hiResBuf = await getSyntheticHiResBuffer();
    const syntheticResolver: PreflightAssetResolver = {
      async readStoryAsset() {
        return hiResBuf;
      },
    };

    const report = await runStoryPreflight(syntheticStory, 'square', syntheticResolver);
    dryRunPreflight = {
      readyForPrint: report.readyForPrint,
      score: report.score,
      errors: report.summary.errors,
      warnings: report.summary.warnings,
    };

    if (!report.readyForPrint) {
      errors.push({
        code: 'DRY_RUN_PREFLIGHT_FAILED',
        severity: 'error',
        field: 'theme',
        message: `Syntetyczny test pre-flight nie powiódł się (${report.summary.errors} błędów).`,
        details: { issues: report.issues.filter((i) => i.severity === 'error') },
      });
    }
  }

  return {
    valid: errors.length === 0,
    theme,
    errors,
    warnings,
    ...(dryRunPreflight ? { dryRunPreflight } : {}),
  };
}

/**
 * Audits the entire theme catalog for schema/editorial integrity and 365-day seasonal coverage.
 */
export async function auditThemeCatalog(
  catalog: readonly ThemeCatalogItem[] = getAllThemes(),
): Promise<CatalogAuditReport> {
  const errors: CatalogValidationIssue[] = [];
  const warnings: CatalogValidationIssue[] = [];

  const seenIds = new Set<string>();
  for (const item of catalog) {
    if (seenIds.has(item.id)) {
      errors.push({
        code: 'DUPLICATE_THEME_ID',
        severity: 'error',
        field: `themes.${item.id}`,
        message: `Zduplikowany identyfikator motywu: "${item.id}".`,
      });
    }
    seenIds.add(item.id);

    const res = await validateThemeProposal(item, {
      existingCatalog: catalog,
      allowExistingId: true,
      runDryRunPreflight: true,
    });
    for (const err of res.errors) {
      errors.push({ ...err, field: `${item.id}.${err.field}` });
    }
    for (const warn of res.warnings) {
      warnings.push({ ...warn, field: `${item.id}.${warn.field}` });
    }
  }

  const seasonalItems = catalog.filter(
    (item) =>
      item.season !== 'evergreen' &&
      Boolean(item.activeWindow) &&
      (!item.lifecycleStatus || item.lifecycleStatus === 'active'),
  );
  const evergreenCount = catalog.filter((item) => item.season === 'evergreen').length;

  const uncoveredDaysOfYear: number[] = [];
  // Evaluate all 365 days in non-leap year 2026
  const jan1 = Date.UTC(2026, 0, 1, 12, 0, 0);
  for (let dayOffset = 0; dayOffset < 365; dayOffset += 1) {
    const sampleDate = new Date(jan1 + dayOffset * 24 * 60 * 60 * 1000);
    const hasSeasonal = seasonalItems.some((item) => isThemeActiveOnDate(item, sampleDate));
    if (!hasSeasonal) {
      uncoveredDaysOfYear.push(dayOffset + 1);
    }
  }

  const coveredDays = 365 - uncoveredDaysOfYear.length;
  const seasonalCoveragePercent = Number(((coveredDays / 365) * 100).toFixed(1));

  if (uncoveredDaysOfYear.length > 0) {
    warnings.push({
      code: 'SEASONAL_CALENDAR_GAPS',
      severity: 'warning',
      field: 'catalog',
      message: `Katalog ma ${uncoveredDaysOfYear.length} dni w roku bez aktywnego motywu sezonowego.`,
      details: { uncoveredDaysCount: uncoveredDaysOfYear.length },
    });
  }

  return {
    valid: errors.length === 0,
    totalThemes: catalog.length,
    evergreenCount,
    seasonalCount: seasonalItems.length,
    uncoveredDaysOfYear,
    seasonalCoveragePercent,
    errors,
    warnings,
  };
}
