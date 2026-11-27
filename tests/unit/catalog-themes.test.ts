import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GET as getCatalogDrafts, POST as postCatalogDrafts } from '@/app/api/catalog/drafts/route';
import { GET as getCatalogThemes } from '@/app/api/catalog/themes/route';
import { POST as validateCatalogTheme } from '@/app/api/catalog/validate/route';
import { computeEasterSunday, getPolishHolidaysForYear } from '@/lib/catalog/holidays';
import {
  ThemeCatalogItemSchema,
  getActiveThemes,
  getAllThemes,
  getEvergreenThemes,
  getUpcomingSeasonalThemes,
  isThemeActiveOnDate,
  isValidMonthDay,
  parseCatalogDateParam,
} from '@/lib/catalog/themes';
import { auditThemeCatalog, validateThemeProposal } from '@/lib/catalog/validator';
import { buildCoverPrompt } from '@/lib/polish/prompts';
import { THEME_INSPIRATIONS } from '@/lib/polish/templates';
import { resetStorageRootCache } from '@/lib/storage/paths';

let tempDir = '';
const origDataDir = process.env.BAJKOKREATOR_DATA_DIR;

afterEach(async () => {
  if (origDataDir === undefined) {
    delete process.env.BAJKOKREATOR_DATA_DIR;
  } else {
    process.env.BAJKOKREATOR_DATA_DIR = origDataDir;
  }
  resetStorageRootCache();
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = '';
  }
});

describe('Seasonal & Evergreen Theme Catalog (M4)', () => {
  it('preserves all 6 evergreen inspirations and achieves 100% 365-day seasonal coverage', async () => {
    const evergreen = getEvergreenThemes();
    expect(evergreen).toHaveLength(6);
    expect(THEME_INSPIRATIONS).toHaveLength(6);
    expect(THEME_INSPIRATIONS.map((t) => t.id)).toEqual(evergreen.map((t) => t.id));

    const audit = await auditThemeCatalog();
    expect(audit.valid).toBe(true);
    expect(audit.errors).toEqual([]);
    expect(audit.seasonalCoveragePercent).toBe(100);
    expect(audit.uncoveredDaysOfYear).toEqual([]);
  });

  it('handles year-wrapping seasonal window (Christmas Nov 15 -> Jan 6) and rejects impossible MM-DD dates', () => {
    expect(isValidMonthDay('02-31')).toBe(false);
    expect(isValidMonthDay('04-31')).toBe(false);
    expect(isValidMonthDay('02-28')).toBe(true);
    expect(isValidMonthDay('11-15')).toBe(true);

    expect(
      ThemeCatalogItemSchema.safeParse({
        id: 'bad-feb',
        label: 'Test',
        theme: 'Przygoda z nieprawidłową datą kalendarza',
        suggestedMood: 'warm-cozy',
        activeWindow: { startMonthDay: '02-31', endMonthDay: '03-10' },
      }).success,
    ).toBe(false);

    const christmas = getAllThemes().find((t) => t.id === 'winter-star-express');
    expect(christmas).toBeDefined();

    expect(isThemeActiveOnDate(christmas!, new Date('2026-11-14T12:00:00Z'))).toBe(false);
    expect(isThemeActiveOnDate(christmas!, new Date('2026-11-15T12:00:00Z'))).toBe(true);
    expect(isThemeActiveOnDate(christmas!, new Date('2026-12-24T12:00:00Z'))).toBe(true);
    expect(isThemeActiveOnDate(christmas!, new Date('2027-01-06T12:00:00Z'))).toBe(true);
    expect(isThemeActiveOnDate(christmas!, new Date('2027-01-07T12:00:00Z'))).toBe(false);
  });

  it('prioritizes active seasonal themes ahead of evergreen themes and wires seasonal promptHints', () => {
    const decThemes = getActiveThemes(new Date('2026-12-10T12:00:00Z'));
    expect(decThemes[0].id).toBe('winter-star-express');
    expect(decThemes[0].badge).toBe('Świąteczne');

    const janThemes = getActiveThemes(new Date('2026-01-20T12:00:00Z'));
    expect(janThemes[0].id).toBe('grandparents-memory-jar');

    const juneThemes = getActiveThemes(new Date('2026-06-01T12:00:00Z'));
    expect(juneThemes[0].id).toBe('childrens-day-island');

    const coverPrompt = buildCoverPrompt({
      childName: 'Zosia',
      childAge: 5,
      gender: 'girl',
      theme: decThemes[0].theme,
      themeId: 'winter-star-express',
      artStyle: 'watercolor',
      mood: 'warm-cozy',
      pageCount: 10,
    }, 'Zosia, 5-year-old girl');
    expect(coverPrompt).toContain('crimson scarf');
    expect(coverPrompt).toContain('golden Christmas star');
  });

  it('computes Polish movable holidays via Gregorian Computus accurately', () => {
    // 2026 Easter Sunday = 2026-04-05; 2027 Easter Sunday = 2027-03-28
    expect(computeEasterSunday(2026).toISOString().slice(0, 10)).toBe('2026-04-05');
    expect(computeEasterSunday(2027).toISOString().slice(0, 10)).toBe('2027-03-28');
    const holidays2026 = getPolishHolidaysForYear(2026);
    expect(holidays2026.find((h) => h.id === 'corpus-christi')?.dateIso).toBe('2026-06-04');
  });

  it('validates catalog date, strict integer upcomingDays, and age query parameters on GET /api/catalog/themes', async () => {
    expect(parseCatalogDateParam('2026-12-06')?.toISOString().slice(0, 10)).toBe('2026-12-06');
    expect(parseCatalogDateParam('2026-02-31')).toBeNull();
    expect(getUpcomingSeasonalThemes(new Date('2026-11-01T12:00:00Z'), 30).length).toBeGreaterThan(0);

    const okRes = await getCatalogThemes(
      new Request('http://localhost/api/catalog/themes?date=2026-12-06&upcomingDays=45&age=5'),
    );
    expect(okRes.status).toBe(200);
    const okJson = (await okRes.json()) as {
      referenceDate: string;
      themes: Array<{ id: string }>;
      upcomingSeasonal: Array<{ id: string; theme: { id: string }; startsInDays: number }>;
    };
    expect(okJson.referenceDate).toBe('2026-12-06');
    expect(okJson.themes[0].id).toBe('winter-star-express');
    expect(okJson.upcomingSeasonal.some((e) => e.id === 'grandparents-memory-jar')).toBe(true);

    for (const badUrl of [
      'http://localhost/api/catalog/themes?date=2026-02-30',
      'http://localhost/api/catalog/themes?upcomingDays=10abc',
      'http://localhost/api/catalog/themes?upcomingDays=0',
      'http://localhost/api/catalog/themes?age=0',
      'http://localhost/api/catalog/themes?age=13',
    ]) {
      const res = await getCatalogThemes(new Request(badUrl));
      expect(res.status).toBe(400);
    }
  });

  it('validates theme proposals with synthetic dry-run preflight and stages drafts non-destructively', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bajkokreator-m4-test-'));
    process.env.BAJKOKREATOR_DATA_DIR = tempDir;
    resetStorageRootCache();

    const validProposal = {
      id: 'winter-lanterns-test',
      label: 'Zimowe Lampiony Nad Jeziorem',
      theme:
        'ciepła zimowa opowieść o wieczornym spacerze z papierowymi lampionami nad zamarzniętym jeziorem',
      suggestedMood: 'warm-cozy',
      suggestedArtStyle: 'watercolor',
      season: 'winter',
      badge: 'Ferie',
      priority: 12,
      activeWindow: { startMonthDay: '02-01', endMonthDay: '02-20' },
      ageRange: { min: 3, max: 9 },
      tags: ['zima', 'lampiony'],
    };

    const valRes = await validateCatalogTheme(
      new Request('http://localhost/api/catalog/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: validProposal }),
      }),
    );
    expect(valRes.status).toBe(200);
    const valJson = (await valRes.json()) as {
      valid: boolean;
      errors: unknown[];
      dryRunPreflight?: { readyForPrint: boolean; score: number };
    };
    expect(valJson.valid).toBe(true);
    expect(valJson.errors).toEqual([]);
    expect(valJson.dryRunPreflight?.readyForPrint).toBe(true);
    expect(valJson.dryRunPreflight?.score).toBeGreaterThanOrEqual(80);

    // Rejects duplicate ID + placeholder + invalid ageRange
    const broken = await validateThemeProposal({
      ...validProposal,
      id: 'lantern-forest',
      label: 'Ze {{TODO}}',
      ageRange: { min: 10, max: 3 },
    });
    expect(broken.valid).toBe(false);
    expect(broken.errors.length).toBeGreaterThanOrEqual(3);

    // Stage draft via POST /api/catalog/drafts without mutating live themes.json
    const stageRes = await postCatalogDrafts(
      new Request('http://localhost/api/catalog/drafts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: validProposal, notes: 'Propozycja agenta sezonowego' }),
      }),
    );
    expect(stageRes.status).toBe(201);

    const listRes = await getCatalogDrafts(new Request('http://localhost/api/catalog/drafts'));
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { drafts: Array<{ id: string }> };
    expect(listBody.drafts.some((d) => d.id === validProposal.id)).toBe(true);
    expect(getAllThemes().some((t) => t.id === validProposal.id)).toBe(false);
  });
});
