import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as getPreflightRoute } from '@/app/api/stories/[id]/preflight/route';
import { buildPolishStoryDraft } from '@/lib/polish/templates';
import {
  PreflightReportSchema,
  runStoryPreflight,
  type PreflightAssetResolver,
} from '@/lib/preflight/checker';
import { resetStorageRootCache } from '@/lib/storage/paths';
import { resetStoryRepository, saveStory } from '@/lib/storage/store';
import type { StoryInput, StoryRecord } from '@/lib/types/story';

async function makePng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 210, g: 170, b: 130 },
    },
  })
    .png()
    .toBuffer();
}

function makeStory(overrides?: Partial<StoryRecord>): StoryRecord {
  const input: StoryInput = {
    childName: 'Zosia',
    childAge: 5,
    gender: 'girl',
    companion: 'rudy kotek Mruczek',
    theme: 'Wyprawa do zaczarowanego lasu świetlików',
    artStyle: 'watercolor',
    mood: 'warm-cozy',
    pageCount: 10,
    dedicationFrom: 'Mama i Tata',
  };
  const draft = buildPolishStoryDraft(input);
  const now = new Date().toISOString();

  return {
    id: 'zosia-preflight-01',
    createdAt: now,
    updatedAt: now,
    provider: 'demo',
    generationMode: 'full',
    generationStage: 'complete',
    bookFormat: 'square',
    input,
    title: draft.title,
    subtitle: draft.subtitle,
    dedicationText: draft.dedicationText,
    backCoverBlurb: draft.backCoverBlurb,
    characterBible: draft.characterBible,
    coverPrompt: draft.coverPrompt,
    coverFilename: null,
    demoCoverPath: '/demo-art/cover.jpg',
    coverStatus: 'ready',
    referencePhotos: ['ref-1.jpg'],
    pages: draft.pages.map((p) => ({
      pageNumber: p.pageNumber,
      chapterTitle: p.chapterTitle,
      text: p.text,
      imagePrompt: p.imagePrompt,
      imageFilename: null,
      demoAssetPath: `/demo-art/page-${String(p.pageNumber).padStart(2, '0')}.jpg`,
      imageStatus: 'ready',
    })),
    modelsUsed: {
      textModel: 'demo-polish-storyteller-v1',
      imageModel: 'demo-watercolor-plates-v1',
    },
    ...overrides,
  };
}

function makeHiResStory(overrides?: Partial<StoryRecord>): StoryRecord {
  const base = makeStory(overrides);
  return {
    ...base,
    coverFilename: 'cover.png',
    demoCoverPath: null,
    pages: base.pages.map((p) => ({
      ...p,
      imageFilename: `page-${p.pageNumber}.png`,
      demoAssetPath: null,
    })),
    ...overrides,
  };
}

describe('runStoryPreflight', () => {
  it('passes a complete demo story and reports multiple-of-4 padding guidance', async () => {
    const story = makeStory({ referencePhotos: [] });
    const report = await runStoryPreflight(story, 'square');

    expect(PreflightReportSchema.parse(report)).toBeTruthy();
    expect(report.readyForPrint).toBe(true);
    expect(report.summary.errors).toBe(0);
    expect(report.metrics.totalPdfPages).toBe(13);
    expect(report.metrics.paddingNeededForMultipleOf4).toBe(3);
    expect(report.metrics.expectedArtworkSlots).toBe(11);
    expect(report.metrics.readyArtworkSlots).toBe(11);
    expect(report.metrics.minEffectiveDpi).toBeGreaterThan(100);
    expect(report.issues.some((i) => i.code === 'PAGE_COUNT_PADDING_RECOMMENDED')).toBe(true);
    expect(report.issues.some((i) => i.code === 'DEDICATION_PHOTO_ABSENT')).toBe(true);
  });

  it('passes with 100 score when all illustrations meet print-grade 240+ DPI', async () => {
    const printHiRes = await makePng(1900, 1400);
    const story = makeHiResStory();

    const resolver: PreflightAssetResolver = {
      async readStoryAsset() {
        return printHiRes;
      },
    };

    const report = await runStoryPreflight(story, 'square', resolver);
    expect(report.readyForPrint).toBe(true);
    expect(report.summary.errors).toBe(0);
    expect(report.summary.warnings).toBe(0);
    expect(report.score).toBe(100);
    expect(report.metrics.minEffectiveDpi).toBeGreaterThanOrEqual(240);
  });

  it('blocks printing on incomplete stage, low-DPI images, and unresolved placeholders', async () => {
    const tinyThumb = await makePng(200, 200);
    const base = makeStory();
    const brokenPages = base.pages.map((p, idx) => {
      if (idx === 0) {
        return {
          ...p,
          text: 'Witaj {{childName}}, tutaj jest TODO tekst.',
          imageFilename: 'page-1.png',
          demoAssetPath: null,
        };
      }
      if (idx === 1) {
        return {
          ...p,
          imageStatus: 'pending' as const,
          demoAssetPath: null,
        };
      }
      return p;
    });

    const story = makeStory({
      generationStage: 'preview',
      pages: brokenPages,
    });

    const resolver: PreflightAssetResolver = {
      async readStoryAsset(_id, filename) {
        return filename === 'page-1.png' ? tinyThumb : null;
      },
    };

    const report = await runStoryPreflight(story, 'square', resolver);
    expect(report.readyForPrint).toBe(false);
    expect(report.issues.some((i) => i.code === 'STORY_INCOMPLETE_STAGE')).toBe(true);
    expect(report.issues.some((i) => i.code === 'UNRESOLVED_PLACEHOLDER')).toBe(true);
    expect(report.issues.some((i) => i.code === 'LOW_IMAGE_RESOLUTION_BLOCKING')).toBe(true);
    expect(report.issues.some((i) => i.code === 'MISSING_ARTWORK')).toBe(true);
  });

  it('evaluates a4-landscape using shared layout-spec slot geometry', async () => {
    const story = makeHiResStory({ bookFormat: 'a4-landscape' });

    // 1800x1800 meets >=240 DPI for all a4-landscape slots (cover 437.78x519.28, page 432x507.28, dedication 210x210)
    const a4PrintHiRes = await makePng(1800, 1800);
    const hiResReport = await runStoryPreflight(story, 'a4-landscape', {
      async readStoryAsset() {
        return a4PrintHiRes;
      },
    });
    expect(hiResReport.format).toBe('a4-landscape');
    expect(hiResReport.readyForPrint).toBe(true);
    expect(hiResReport.score).toBe(100);
    expect(hiResReport.summary.errors).toBe(0);
    expect(hiResReport.summary.warnings).toBe(0);
    expect(hiResReport.metrics.minEffectiveDpi).toBeGreaterThanOrEqual(240);

    // 1900x1400 yields ~194 DPI on a4-landscape cover (height 519.28 pt = 7.21 in) -> warning
    const midRes = await makePng(1900, 1400);
    const midResReport = await runStoryPreflight(story, 'a4-landscape', {
      async readStoryAsset() {
        return midRes;
      },
    });
    expect(midResReport.readyForPrint).toBe(true);
    expect(
      midResReport.issues.some(
        (i) => i.code === 'LOW_IMAGE_RESOLUTION_WARNING' && i.slot === 'cover',
      ),
    ).toBe(true);
  });

  it('validates dedication reference photo (missing, corrupt, blocking DPI, warning DPI, absent)', async () => {
    const artHiRes = await makePng(1900, 1400);
    const story = makeHiResStory({ referencePhotos: ['ref-1.jpg'] });

    // 1. Missing ref-1.jpg -> blocking DEDICATION_PHOTO_MISSING
    const missingReport = await runStoryPreflight(story, 'square', {
      async readStoryAsset(_id, filename) {
        return filename === 'ref-1.jpg' ? null : artHiRes;
      },
    });
    expect(missingReport.readyForPrint).toBe(false);
    expect(
      missingReport.issues.some(
        (i) =>
          i.code === 'DEDICATION_PHOTO_MISSING' &&
          i.severity === 'error' &&
          i.slot === 'dedication',
      ),
    ).toBe(true);
    expect(missingReport.metrics.expectedArtworkSlots).toBe(11);
    expect(missingReport.metrics.readyArtworkSlots).toBe(11);

    // 2. Corrupt ref-1.jpg -> blocking CORRUPT_IMAGE on dedication slot
    const corruptReport = await runStoryPreflight(story, 'square', {
      async readStoryAsset(_id, filename) {
        return filename === 'ref-1.jpg' ? Buffer.from('not-an-image') : artHiRes;
      },
    });
    expect(corruptReport.readyForPrint).toBe(false);
    expect(
      corruptReport.issues.some(
        (i) => i.code === 'CORRUPT_IMAGE' && i.severity === 'error' && i.slot === 'dedication',
      ),
    ).toBe(true);

    // 3. Blocking low DPI ref-1.jpg (120x120 on 186x186 pt ≈ 46 DPI < 100)
    const tinyRef = await makePng(120, 120);
    const lowDpiReport = await runStoryPreflight(story, 'square', {
      async readStoryAsset(_id, filename) {
        return filename === 'ref-1.jpg' ? tinyRef : artHiRes;
      },
    });
    expect(lowDpiReport.readyForPrint).toBe(false);
    expect(
      lowDpiReport.issues.some(
        (i) =>
          i.code === 'LOW_IMAGE_RESOLUTION_BLOCKING' &&
          i.severity === 'error' &&
          i.slot === 'dedication',
      ),
    ).toBe(true);
    expect(lowDpiReport.metrics.minEffectiveDpi).toBeLessThan(100);

    // 4. Warning DPI ref-1.jpg (400x400 on 186x186 pt ≈ 155 DPI < 240)
    const midRef = await makePng(400, 400);
    const warnDpiReport = await runStoryPreflight(story, 'square', {
      async readStoryAsset(_id, filename) {
        return filename === 'ref-1.jpg' ? midRef : artHiRes;
      },
    });
    expect(warnDpiReport.readyForPrint).toBe(true);
    expect(
      warnDpiReport.issues.some(
        (i) =>
          i.code === 'LOW_IMAGE_RESOLUTION_WARNING' &&
          i.severity === 'warning' &&
          i.slot === 'dedication',
      ),
    ).toBe(true);

    // 5. Absent / RODO-purged referencePhotos: [] -> info only, readyForPrint: true
    const purgedStory = makeHiResStory({ referencePhotos: [] });
    const purgedReport = await runStoryPreflight(purgedStory, 'square', {
      async readStoryAsset() {
        return artHiRes;
      },
    });
    expect(purgedReport.readyForPrint).toBe(true);
    expect(purgedReport.score).toBe(100);
    expect(
      purgedReport.issues.some(
        (i) =>
          i.code === 'DEDICATION_PHOTO_ABSENT' &&
          i.severity === 'info' &&
          i.slot === 'dedication',
      ),
    ).toBe(true);
  });

  it('detects TEXT_OVERFLOW_RISK accurately using wrapped line budgets for both long prose and newlines', async () => {
    const hiRes = await makePng(1800, 1800);
    const resolver: PreflightAssetResolver = { async readStoryAsset() { return hiRes; } };
    const base = makeHiResStory();

    // ~920 chars (previously missed by crude maxLen: 1200) overflows 8-line square budget
    const longProse =
      'Zosia wędrowała powoli krętą ścieżką wśród wysokich paproci i srebrnych świerków, słuchając szeptu wiatru, który opowiadał dawne historie o dzielnych podróżnikach i ukrytych polanach pełnych świetlików. '.repeat(
        5,
      );
    expect(longProse.length).toBeLessThan(1200);

    // 10 short lines separated by explicit newlines (total < 200 chars) also overflows 8-line square budget
    const manyNewlines = Array.from({ length: 10 }, (_, idx) => `Wers ${idx + 1} dla Zosi.`).join(
      '\n',
    );

    const overflowStory = makeHiResStory({
      pages: base.pages.map((p) => {
        if (p.pageNumber === 1) return { ...p, text: longProse };
        if (p.pageNumber === 2) return { ...p, text: manyNewlines };
        return p;
      }),
    });

    const squareReport = await runStoryPreflight(overflowStory, 'square', resolver);
    const p1Issue = squareReport.issues.find(
      (i) => i.code === 'TEXT_OVERFLOW_RISK' && i.slot === 1,
    );
    const p2Issue = squareReport.issues.find(
      (i) => i.code === 'TEXT_OVERFLOW_RISK' && i.slot === 2,
    );
    expect(p1Issue).toBeDefined();
    expect(Number(p1Issue?.details?.estimatedLines)).toBeGreaterThan(8);
    expect(p2Issue).toBeDefined();
    expect(Number(p2Issue?.details?.estimatedLines)).toBeGreaterThan(8);

    // Same 10-line newline poem fits comfortably inside a4-landscape (19-line budget)
    const a4Report = await runStoryPreflight(overflowStory, 'a4-landscape', resolver);
    expect(
      a4Report.issues.some((i) => i.code === 'TEXT_OVERFLOW_RISK' && i.slot === 2),
    ).toBe(false);
  });

  it('prevents Ala/znalazła false positives with Polish word-boundary matching', async () => {
    const hiRes = await makePng(1900, 1400);
    const resolver: PreflightAssetResolver = { async readStoryAsset() { return hiRes; } };
    const base = makeHiResStory();

    const falsePositiveStory = makeHiResStory({
      input: { ...base.input, childName: 'Ala', gender: 'girl' },
      title: 'Koralowa fala i tajemniczy balon',
      dedicationText: 'Każda podróż zaczyna się wtedy, gdy dziewczynka znalazła mapę na polanie.',
      pages: base.pages.map((p) => ({
        ...p,
        text: 'Dziewczynka znalazła bursztyn w koralach i spojrzała na falę pod żaglami.',
      })),
    });

    const missingNameReport = await runStoryPreflight(falsePositiveStory, 'square', resolver);
    expect(missingNameReport.issues.some((i) => i.code === 'CHILD_NAME_NOT_FOUND')).toBe(true);

    // Adding standalone declined form "Ali" resolves CHILD_NAME_NOT_FOUND
    const declinedStory = {
      ...falsePositiveStory,
      dedicationText: 'Ta opowieść powstała specjalnie dla Ali na pamiątkę wspólnych wieczorów.',
    };
    const foundNameReport = await runStoryPreflight(declinedStory, 'square', resolver);
    expect(foundNameReport.issues.some((i) => i.code === 'CHILD_NAME_NOT_FOUND')).toBe(false);
  });

  it('matches declined multi-word, hyphenated, and Polish-diacritic child names across cases', async () => {
    const hiRes = await makePng(1900, 1400);
    const resolver: PreflightAssetResolver = { async readStoryAsset() { return hiRes; } };
    const base = makeHiResStory();

    // Multi-word "Jan Paweł" matched via Genitive/Dative/Vocative without Nominative
    const janPawelStory = makeHiResStory({
      input: { ...base.input, childName: 'Jan Paweł', gender: 'boy' },
      title: 'Leśna wyprawa po złoty kompas',
      dedicationText: 'Opowieść dla Jana Pawła pełna odwagi i ciepła.',
      pages: base.pages.map((p) => ({
        ...p,
        text: 'Mądra sowa wręczyła mapę Janowi Pawłowi i zawołała: naprzód, Janie Pawle!',
      })),
    });
    const jpReport = await runStoryPreflight(janPawelStory, 'square', resolver);
    expect(jpReport.issues.some((i) => i.code === 'CHILD_NAME_NOT_FOUND')).toBe(false);

    // Hyphenated "Anna-Maria" matched via Genitive "Anny-Marii"
    const annaMariaStory = makeHiResStory({
      input: { ...base.input, childName: 'Anna-Maria', gender: 'girl' },
      title: 'Sekretny ogród świetlików',
      dedicationText: 'Książeczka dla Anny-Marii z najcieplejszymi życzeniami.',
      pages: base.pages.map((p) => ({
        ...p,
        text: 'Mały jeż przywitał się serdecznie z Anną-Marią nad strumykiem.',
      })),
    });
    const amReport = await runStoryPreflight(annaMariaStory, 'square', resolver);
    expect(amReport.issues.some((i) => i.code === 'CHILD_NAME_NOT_FOUND')).toBe(false);

    // Leading Polish diacritic "Łucja" matched cleanly on Unicode word boundaries
    const lucjaStory = makeHiResStory({
      input: { ...base.input, childName: 'Łucja', gender: 'girl' },
      title: 'Gwiazdka nad polaną',
      dedicationText: 'Niech ta bajka rozświetla każdy wieczór.',
      pages: base.pages.map((p) => ({
        ...p,
        text: 'Łucja otworzyła drewnianą bramkę i ruszyła w stronę łąki.',
      })),
    });
    const lucjaReport = await runStoryPreflight(lucjaStory, 'square', resolver);
    expect(lucjaReport.issues.some((i) => i.code === 'CHILD_NAME_NOT_FOUND')).toBe(false);
  });

  it('emits UNENCODABLE_GLYPHS_WARNING for emojis while allowing Polish diacritics and typography', async () => {
    const hiRes = await makePng(1900, 1400);
    const resolver: PreflightAssetResolver = { async readStoryAsset() { return hiRes; } };
    const base = makeHiResStory();

    const emojiStory = makeHiResStory({
      title: 'Przygoda Zosi ✨🦊 w lesie',
      pages: base.pages.map((p) =>
        p.pageNumber === 1 ? { ...p, text: `${p.text} Wielka radość 🌟!` } : p,
      ),
    });

    const emojiReport = await runStoryPreflight(emojiStory, 'square', resolver);
    const coverGlyphIssue = emojiReport.issues.find(
      (i) => i.code === 'UNENCODABLE_GLYPHS_WARNING' && i.slot === 'cover',
    );
    const pageGlyphIssue = emojiReport.issues.find(
      (i) => i.code === 'UNENCODABLE_GLYPHS_WARNING' && i.slot === 1,
    );
    expect(coverGlyphIssue).toBeDefined();
    expect(coverGlyphIssue?.severity).toBe('warning');
    expect(coverGlyphIssue?.details?.glyphs).toEqual(expect.arrayContaining(['✨', '🦊']));
    expect(pageGlyphIssue).toBeDefined();
    expect(pageGlyphIssue?.details?.glyphs).toEqual(expect.arrayContaining(['🌟']));

    // Pure Polish editorial typography produces zero UNENCODABLE_GLYPHS_WARNING
    const cleanPolishStory = makeHiResStory({
      title: '„Zażółć gęślą jaźń” — przygoda Zosi…',
    });
    const cleanReport = await runStoryPreflight(cleanPolishStory, 'square', resolver);
    expect(cleanReport.issues.some((i) => i.code === 'UNENCODABLE_GLYPHS_WARNING')).toBe(false);
  });

  it('detects EXTREME_ASPECT_RATIO_MISMATCH, TEXT_TOO_SHORT, and CORRUPT_IMAGE on artwork slots', async () => {
    const hiRes = await makePng(1900, 1400);
    const extremeBanner = await makePng(3000, 600); // 5.0 ratio vs 1.64 square page -> 3.05 > 2.2
    const base = makeHiResStory();

    const story = makeHiResStory({
      pages: base.pages.map((p) => {
        if (p.pageNumber === 2) {
          return { ...p, text: 'Krótko.' };
        }
        return p;
      }),
    });

    const report = await runStoryPreflight(story, 'square', {
      async readStoryAsset(_id, filename) {
        if (filename === 'page-1.png') return extremeBanner;
        if (filename === 'page-3.png') return Buffer.from('corrupt-image-bytes');
        return hiRes;
      },
    });

    expect(report.readyForPrint).toBe(false);
    expect(
      report.issues.some(
        (i) =>
          i.code === 'EXTREME_ASPECT_RATIO_MISMATCH' &&
          i.severity === 'warning' &&
          i.slot === 1,
      ),
    ).toBe(true);
    expect(
      report.issues.some(
        (i) => i.code === 'TEXT_TOO_SHORT' && i.severity === 'warning' && i.slot === 2,
      ),
    ).toBe(true);
    expect(
      report.issues.some(
        (i) => i.code === 'CORRUPT_IMAGE' && i.severity === 'error' && i.slot === 3,
      ),
    ).toBe(true);
  });
});

describe('GET /api/stories/[id]/preflight route handling', () => {
  let tempDataDir = '';
  const originalDataDir = process.env.BAJKOKREATOR_DATA_DIR;
  const savedStory = makeStory({
    id: 'zosia-preflight-route-01',
    referencePhotos: [],
  });

  beforeAll(async () => {
    tempDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bajkokreator-preflight-route-'));
    process.env.BAJKOKREATOR_DATA_DIR = tempDataDir;
    resetStorageRootCache();
    resetStoryRepository();
    await saveStory(savedStory);
  });

  afterAll(async () => {
    if (originalDataDir === undefined) {
      delete process.env.BAJKOKREATOR_DATA_DIR;
    } else {
      process.env.BAJKOKREATOR_DATA_DIR = originalDataDir;
    }
    resetStorageRootCache();
    resetStoryRepository();
    if (tempDataDir) {
      await fs.rm(tempDataDir, { recursive: true, force: true });
    }
  });

  it('returns 400 on invalid story ID', async () => {
    const res = await getPreflightRoute(
      new Request('http://localhost/api/stories/..%2Fbad!/preflight'),
      { params: Promise.resolve({ id: '../bad!' }) },
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 NOT_FOUND with Cache-Control: no-store on missing story', async () => {
    const res = await getPreflightRoute(
      new Request('http://localhost/api/stories/missing-story-0001/preflight'),
      { params: Promise.resolve({ id: 'missing-story-0001' }) },
    );
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const body = await res.json();
    expect(body.code).toBe('NOT_FOUND');
  });

  it('returns 400 INVALID_BOOK_FORMAT with Cache-Control: no-store on invalid or empty format', async () => {
    for (const query of ['format=poster-a0', 'format=']) {
      const res = await getPreflightRoute(
        new Request(`http://localhost/api/stories/${savedStory.id}/preflight?${query}`),
        { params: Promise.resolve({ id: savedStory.id }) },
      );
      expect(res.status).toBe(400);
      expect(res.headers.get('cache-control')).toContain('no-store');
      const body = await res.json();
      expect(body.code).toBe('INVALID_BOOK_FORMAT');
    }
  });

  it('returns 200 with validated preflight report for a4-landscape format', async () => {
    const res = await getPreflightRoute(
      new Request(`http://localhost/api/stories/${savedStory.id}/preflight?format=a4-landscape`),
      { params: Promise.resolve({ id: savedStory.id }) },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const body = await res.json();
    const parsed = PreflightReportSchema.parse(body.report);
    expect(parsed.storyId).toBe(savedStory.id);
    expect(parsed.format).toBe('a4-landscape');
    expect(parsed.readyForPrint).toBe(true);
  });
});
