import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  ART_STYLES,
  AUTH_STRATEGIES,
  ArtStyleSchema,
  AssetFilenameSchema,
  AuthStrategySchema,
  BOOK_FORMATS,
  BookFormatSchema,
  CHILD_GENDERS,
  ChildGenderSchema,
  CreateStoryPayloadSchema,
  DEFAULT_GEMINI_IMAGE_SIZE,
  DEFAULT_PAGE_COUNT,
  DEFAULT_RUNTIME_SETTINGS,
  GEMINI_IMAGE_SIZES,
  GENERATION_MODES,
  GENERATION_STAGES,
  GeminiImageSizeSchema,
  GenerationModeSchema,
  GenerationStageSchema,
  IMAGE_STATUSES,
  IllustrationSlotSchema,
  ImageStatusSchema,
  MAX_PHOTO_FILE_BYTES,
  ModelIdSchema,
  PROVIDER_IDS,
  PatchPageSchema,
  PatchSettingsSchema,
  PatchStorySchema,
  PhotoBatchSchema,
  ProviderIdSchema,
  RuntimeSettingsSchema,
  STORAGE_MODES,
  STORY_MOODS,
  StorageModeSchema,
  StoryBlueprintSchema,
  StoryIdSchema,
  StoryInputSchema,
  StoryMoodSchema,
  StoryPageSchema,
  StoryRecordSchema,
  StorySummarySchema,
  UploadedPhotoMetaSchema,
  extractStoryInput,
  formatZodIssues,
  type PatchPagePayload,
  type PatchStoryPayload,
  type RuntimeSettings,
  type StoryBlueprint,
  type StoryInput,
  type StoryPage,
  type StoryRecord,
  type StorySummary,
} from '@/lib/types/story';

function assertBidirectionalTypeMatch<A, B extends A>(
  _proof?: B extends A ? (A extends B ? true : never) : never,
): boolean {
  void _proof;
  return true;
}

describe('0. Compile-time domain interface vs Zod schema alignment', () => {
  it('ensures exported interfaces and Zod v4 output types remain bidirectionally assignable', () => {
    expect(assertBidirectionalTypeMatch<StoryInput, z.output<typeof StoryInputSchema>>(true)).toBe(
      true,
    );
    expect(assertBidirectionalTypeMatch<StoryPage, z.output<typeof StoryPageSchema>>(true)).toBe(
      true,
    );
    expect(
      assertBidirectionalTypeMatch<StoryRecord, z.output<typeof StoryRecordSchema>>(true),
    ).toBe(true);
    expect(
      assertBidirectionalTypeMatch<StorySummary, z.output<typeof StorySummarySchema>>(true),
    ).toBe(true);
    expect(
      assertBidirectionalTypeMatch<RuntimeSettings, z.output<typeof RuntimeSettingsSchema>>(true),
    ).toBe(true);
    expect(
      assertBidirectionalTypeMatch<StoryBlueprint, z.output<typeof StoryBlueprintSchema>>(true),
    ).toBe(true);
    expect(
      assertBidirectionalTypeMatch<
        { text: string; chapterTitle?: string },
        PatchPagePayload
      >(true),
    ).toBe(true);
    expect(
      assertBidirectionalTypeMatch<PatchStoryPayload, z.output<typeof PatchStorySchema>>(true),
    ).toBe(true);
  });
});

function makeMinimalStoryInput() {
  return {
    childName: 'Zosia',
    childAge: 5,
    gender: 'girl' as const,
    theme: 'Wyprawa do zaczarowanego lasu po złote żołędzie',
    artStyle: 'watercolor' as const,
    mood: 'warm-cozy' as const,
  };
}

function makeCompleteStoryRecord(
  overrides: Partial<StoryRecord> = {},
): StoryRecord {
  const now = '2026-11-25T18:30:00.000Z';
  const pages: StoryPage[] = Array.from({ length: 10 }, (_, idx) => {
    const num = idx + 1;
    const padded = String(num).padStart(2, '0');
    return {
      pageNumber: num,
      chapterTitle: `Rozdział ${num}: Leśna ścieżka`,
      text: `Zosia odkryła tajemniczą ścieżkę numer ${num} — zażółć gęślą jaźń.`,
      imagePrompt: `Warm watercolor illustration of scene ${num}`,
      imageFilename: null,
      demoAssetPath: `/demo-art/page-${padded}.jpg`,
      imageStatus: 'ready',
      imageUpdatedAt: now,
    };
  });

  return {
    id: 'zosia-las-2026',
    createdAt: now,
    updatedAt: now,
    provider: 'demo',
    generationMode: 'full',
    generationStage: 'complete',
    bookFormat: 'square',
    input: {
      ...makeMinimalStoryInput(),
      pageCount: 10,
      companion: 'rudy kotek Mruczek',
      dedicationFrom: 'Mama i Tata',
    },
    title: 'Zosia i Zaczarowany Las',
    subtitle: 'Opowieść o odwadze i przyjaźni',
    dedicationText: 'Dla kochanej Zosi na pamiątkę wspólnych wieczorów.',
    backCoverBlurb: 'Ciepła opowieść o tym, jak ciekawość prowadzi do magicznych odkryć.',
    characterBible: 'Zosia, 5-year-old Polish girl with chestnut braids and warm mustard cardigan.',
    coverPrompt: 'Painterly watercolor storybook cover of Zosia and ginger cat in golden forest.',
    coverFilename: null,
    demoCoverPath: '/demo-art/cover.jpg',
    coverStatus: 'ready',
    coverUpdatedAt: now,
    referencePhotos: ['ref-1.jpg'],
    pages,
    modelsUsed: {
      textModel: 'gemini-3.8-flash',
      imageModel: 'gemini-nano-banana-2.1',
    },
    ...overrides,
  };
}

describe('1. Enum schemas', () => {
  it('accepts every canonical enum value from PROJECT.md', () => {
    for (const v of CHILD_GENDERS) expect(ChildGenderSchema.safeParse(v).success).toBe(true);
    for (const v of ART_STYLES) expect(ArtStyleSchema.safeParse(v).success).toBe(true);
    for (const v of STORY_MOODS) expect(StoryMoodSchema.safeParse(v).success).toBe(true);
    for (const v of BOOK_FORMATS) expect(BookFormatSchema.safeParse(v).success).toBe(true);
    for (const v of PROVIDER_IDS) expect(ProviderIdSchema.safeParse(v).success).toBe(true);
    for (const v of AUTH_STRATEGIES) expect(AuthStrategySchema.safeParse(v).success).toBe(true);
    for (const v of GENERATION_MODES) expect(GenerationModeSchema.safeParse(v).success).toBe(true);
    for (const v of GENERATION_STAGES) {
      expect(GenerationStageSchema.safeParse(v).success).toBe(true);
    }
    for (const v of IMAGE_STATUSES) expect(ImageStatusSchema.safeParse(v).success).toBe(true);
  });

  it('rejects legacy/invalid values and exposes Zod v4 error.issues', () => {
    const cases = [
      BookFormatSchema.safeParse('a4'),
      ArtStyleSchema.safeParse('akwarela'),
      StoryMoodSchema.safeParse('cieply'),
      ProviderIdSchema.safeParse('unknown'),
      ChildGenderSchema.safeParse(''),
      ChildGenderSchema.safeParse(null),
      ProviderIdSchema.safeParse(123),
    ];

    for (const result of cases) {
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(Array.isArray(result.error.issues)).toBe(true);
        expect(result.error.issues.length).toBeGreaterThan(0);
        expect(result.error.issues[0].message.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('2. StoryInputSchema', () => {
  it('parses minimal valid input, defaults pageCount to 10, and trims whitespace', () => {
    const parsed = StoryInputSchema.parse({
      ...makeMinimalStoryInput(),
      childName: '  Zosia  ',
      theme: '   Przygoda w chmurach   ',
    });

    expect(parsed.childName).toBe('Zosia');
    expect(parsed.theme).toBe('Przygoda w chmurach');
    expect(parsed.pageCount).toBe(DEFAULT_PAGE_COUNT);
    expect(parsed.companion).toBeUndefined();
    expect(parsed.dedicationFrom).toBeUndefined();
  });

  it('accepts Polish Unicode names and normalizes NFD input to NFC', () => {
    const validNames = [
      'Zosia',
      'Łukasz',
      'Jaś',
      'Żaneta',
      'Świętosław',
      'Anna-Maria',
      'Jan Paweł',
      'Róża',
    ];

    for (const name of validNames) {
      const res = StoryInputSchema.safeParse({ ...makeMinimalStoryInput(), childName: name });
      expect(res.success).toBe(true);
    }

    const nfdName = 'Róża'.normalize('NFD');
    expect(nfdName).not.toBe('Róża'.normalize('NFC'));
    const normalized = StoryInputSchema.parse({
      ...makeMinimalStoryInput(),
      childName: nfdName,
    });
    expect(normalized.childName).toBe('Róża'.normalize('NFC'));
  });

  it('rejects invalid childName values including newlines, tabs, NBSP, and Unicode line separators', () => {
    const invalidNames = [
      '',
      '   ',
      '-Zosia',
      'Zosia-',
      '12345',
      '<script>alert(1)</script>',
      '../etc',
      'A'.repeat(61),
      'Zosia\nEvil',
      'Zosia\r\nEvil',
      'Zosia\tEvil',
      'Zosia\vEvil',
      'Zosia\fEvil',
      'Zosia\u00A0Evil',
      'Zosia\u2028Evil',
      'Zosia\u2029Evil',
      '\u200B',
    ];

    for (const childName of invalidNames) {
      const res = StoryInputSchema.safeParse({ ...makeMinimalStoryInput(), childName });
      expect(res.success).toBe(false);
    }
  });

  it('enforces strict integer bounds 1..12 on childAge', () => {
    for (const age of [1, 5, 12]) {
      expect(
        StoryInputSchema.safeParse({ ...makeMinimalStoryInput(), childAge: age }).success,
      ).toBe(true);
    }

    for (const badAge of [0, -1, 13, 3.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '5', null, true, undefined]) {
      expect(
        StoryInputSchema.safeParse({ ...makeMinimalStoryInput(), childAge: badAge }).success,
      ).toBe(false);
    }
  });

  it('enforces strict integer bounds 4..12 on pageCount with default 10', () => {
    const omitted = StoryInputSchema.parse(makeMinimalStoryInput());
    expect(omitted.pageCount).toBe(10);

    for (const count of [4, 10, 12]) {
      expect(
        StoryInputSchema.safeParse({ ...makeMinimalStoryInput(), pageCount: count }).success,
      ).toBe(true);
    }

    for (const badCount of [0, 3, 13, 8.5, Number.NaN, Number.POSITIVE_INFINITY, '10']) {
      expect(
        StoryInputSchema.safeParse({ ...makeMinimalStoryInput(), pageCount: badCount }).success,
      ).toBe(false);
    }
  });

  it('normalizes optional companion and dedicationFrom fields (including zero-width format chars) and rejects invalid types/lengths', () => {
    for (const blank of [
      undefined,
      null,
      '',
      '   ',
      '\u200B',
      '\u200B\u200C\u200D\uFEFF',
      '  \u200B  ',
    ]) {
      const parsed = StoryInputSchema.parse({
        ...makeMinimalStoryInput(),
        companion: blank,
        dedicationFrom: blank,
      });
      expect(parsed.companion).toBeUndefined();
      expect(parsed.dedicationFrom).toBeUndefined();
    }

    const trimmed = StoryInputSchema.parse({
      ...makeMinimalStoryInput(),
      companion: '  \u200Brudy kotek Mruczek\uFEFF  ',
      dedicationFrom: '  \u200CBabcia i Dziadek\u200D  ',
    });
    expect(trimmed.companion).toBe('rudy kotek Mruczek');
    expect(trimmed.dedicationFrom).toBe('Babcia i Dziadek');

    expect(
      StoryInputSchema.safeParse({ ...makeMinimalStoryInput(), companion: 'x'.repeat(81) })
        .success,
    ).toBe(false);
    expect(
      StoryInputSchema.safeParse({ ...makeMinimalStoryInput(), dedicationFrom: 'x'.repeat(101) })
        .success,
    ).toBe(false);
    expect(
      StoryInputSchema.safeParse({ ...makeMinimalStoryInput(), companion: 123 }).success,
    ).toBe(false);
  });

  it('validates theme length bounds, strips zero-width format characters, and trims', () => {
    const shortOk = StoryInputSchema.parse({
      ...makeMinimalStoryInput(),
      theme: '  \u200BLas\uFEFF  ',
    });
    expect(shortOk.theme).toBe('Las');

    for (const badTheme of ['', '   ', '\u200B\u200B\u200B', '\u200C\u200D\uFEFF', 'ab', 'x'.repeat(401)]) {
      expect(
        StoryInputSchema.safeParse({ ...makeMinimalStoryInput(), theme: badTheme }).success,
      ).toBe(false);
    }
  });
});

describe('3. CreateStoryPayloadSchema & extractStoryInput', () => {
  it('applies clean defaults for omitted generation options', () => {
    const parsed = CreateStoryPayloadSchema.parse(makeMinimalStoryInput());
    expect(parsed.pageCount).toBe(10);
    expect(parsed.generationMode).toBe('full');
    expect(parsed.bookFormat).toBe('square');
    expect(parsed.provider).toBeUndefined();
  });

  it('parses full payload and extracts StoryInput without leaking generation metadata', () => {
    const parsed = CreateStoryPayloadSchema.parse({
      ...makeMinimalStoryInput(),
      companion: 'piesek Burek',
      dedicationFrom: 'Rodzice',
      provider: 'gemini-api',
      generationMode: 'preview-first',
      bookFormat: 'a4-landscape',
    });

    expect(parsed.provider).toBe('gemini-api');
    expect(parsed.generationMode).toBe('preview-first');
    expect(parsed.bookFormat).toBe('a4-landscape');

    const input = extractStoryInput(parsed);
    expect(input).toEqual({
      childName: 'Zosia',
      childAge: 5,
      gender: 'girl',
      companion: 'piesek Burek',
      theme: 'Wyprawa do zaczarowanego lasu po złote żołędzie',
      artStyle: 'watercolor',
      mood: 'warm-cozy',
      pageCount: 10,
      dedicationFrom: 'Rodzice',
    });
    expect('provider' in input).toBe(false);
    expect('bookFormat' in input).toBe(false);
    expect('generationMode' in input).toBe(false);
  });

  it('rejects unknown provider, generationMode, and bookFormat', () => {
    expect(
      CreateStoryPayloadSchema.safeParse({ ...makeMinimalStoryInput(), provider: 'openai' })
        .success,
    ).toBe(false);
    expect(
      CreateStoryPayloadSchema.safeParse({ ...makeMinimalStoryInput(), generationMode: 'fast' })
        .success,
    ).toBe(false);
    expect(
      CreateStoryPayloadSchema.safeParse({ ...makeMinimalStoryInput(), bookFormat: 'a4' })
        .success,
    ).toBe(false);
  });
});

describe('4. PhotoBatchSchema & UploadedPhotoMetaSchema', () => {
  const samplePhoto = (idx: number, mimeType: 'image/jpeg' | 'image/png' | 'image/webp' = 'image/jpeg') => ({
    name: `photo-${idx}.jpg`,
    mimeType,
    sizeBytes: 120_000,
  });

  it('accepts 1 to 4 valid photos across JPEG, PNG, and WebP', () => {
    expect(PhotoBatchSchema.safeParse([samplePhoto(1, 'image/jpeg')]).success).toBe(true);
    expect(
      PhotoBatchSchema.safeParse([
        samplePhoto(1, 'image/jpeg'),
        samplePhoto(2, 'image/png'),
        samplePhoto(3, 'image/webp'),
        samplePhoto(4, 'image/jpeg'),
      ]).success,
    ).toBe(true);
  });

  it('rejects 0 photos and 5 photos', () => {
    expect(PhotoBatchSchema.safeParse([]).success).toBe(false);
    expect(
      PhotoBatchSchema.safeParse([
        samplePhoto(1),
        samplePhoto(2),
        samplePhoto(3),
        samplePhoto(4),
        samplePhoto(5),
      ]).success,
    ).toBe(false);
  });

  it('rejects unsupported MIME types and invalid sizes', () => {
    for (const mimeType of ['image/svg+xml', 'application/pdf', 'image/gif']) {
      expect(
        UploadedPhotoMetaSchema.safeParse({ name: 'x.svg', mimeType, sizeBytes: 1024 }).success,
      ).toBe(false);
    }

    for (const sizeBytes of [0, -10, 12.5, MAX_PHOTO_FILE_BYTES + 1]) {
      expect(
        UploadedPhotoMetaSchema.safeParse({
          name: 'x.jpg',
          mimeType: 'image/jpeg',
          sizeBytes,
        }).success,
      ).toBe(false);
    }
  });
});

describe('5. PatchPageSchema', () => {
  it('accepts valid page text with or without chapterTitle (up to 160 chars) and strips format chars/whitespace', () => {
    const textOnly = PatchPageSchema.parse({ text: '  \u200BZażółć gęślą jaźń.\uFEFF  ' });
    expect(textOnly).toEqual({ text: 'Zażółć gęślą jaźń.' });

    const withTitle = PatchPageSchema.parse({
      text: 'Nowa treść strony.',
      chapterTitle: '  \u200CRozdział 1\u200D  ',
    });
    expect(withTitle).toEqual({
      text: 'Nowa treść strony.',
      chapterTitle: 'Rozdział 1',
    });

    // Aligns with StoryPageSchema & StoryBlueprintSchema max length of 160
    expect(
      PatchPageSchema.safeParse({ text: 'Treść', chapterTitle: 'a'.repeat(121) }).success,
    ).toBe(true);
    expect(
      PatchPageSchema.safeParse({ text: 'Treść', chapterTitle: 'a'.repeat(160) }).success,
    ).toBe(true);
    expect(
      PatchPageSchema.safeParse({ text: 'Treść', chapterTitle: 'a'.repeat(161) }).success,
    ).toBe(false);
  });

  it('rejects empty/whitespace/zero-width text, oversized text, and blank chapterTitle', () => {
    expect(PatchPageSchema.safeParse({ text: '' }).success).toBe(false);
    expect(PatchPageSchema.safeParse({ text: '   ' }).success).toBe(false);
    expect(PatchPageSchema.safeParse({ text: '\u200B' }).success).toBe(false);
    expect(PatchPageSchema.safeParse({ text: '\u200B\u200C\u200D\uFEFF' }).success).toBe(false);
    expect(PatchPageSchema.safeParse({ text: 'a'.repeat(2001) }).success).toBe(false);
    expect(
      PatchPageSchema.safeParse({ text: 'Poprawna treść', chapterTitle: '   ' }).success,
    ).toBe(false);
    expect(
      PatchPageSchema.safeParse({ text: 'Poprawna treść', chapterTitle: '\u200B\uFEFF' }).success,
    ).toBe(false);
  });
});

describe('6. PatchStorySchema', () => {
  it('accepts partial updates for metadata and pages', () => {
    expect(PatchStorySchema.safeParse({ title: 'Nowy tytuł' }).success).toBe(true);
    expect(PatchStorySchema.safeParse({ bookFormat: 'a4-landscape' }).success).toBe(true);
    expect(PatchStorySchema.safeParse({ dedicationText: 'Dla Zosi' }).success).toBe(true);
    expect(PatchStorySchema.safeParse({ backCoverBlurb: 'Opis na tylnej okładce.' }).success).toBe(
      true,
    );
    expect(
      PatchStorySchema.safeParse({ page: { pageNumber: 1, text: 'Zmieniony tekst' } }).success,
    ).toBe(true);
    expect(
      PatchStorySchema.safeParse({
        pages: [
          { pageNumber: 1, text: 'A' },
          { pageNumber: 2, text: 'B' },
        ],
      }).success,
    ).toBe(true);
  });

  it('rejects empty objects, undefined-only payloads, blank/zero-width strings, duplicate pageNumbers, and bad page numbers', () => {
    expect(PatchStorySchema.safeParse({}).success).toBe(false);
    expect(PatchStorySchema.safeParse({ title: undefined }).success).toBe(false);
    expect(PatchStorySchema.safeParse({ title: '   ' }).success).toBe(false);
    expect(PatchStorySchema.safeParse({ title: '\u200B' }).success).toBe(false);
    expect(PatchStorySchema.safeParse({ subtitle: '\uFEFF' }).success).toBe(false);
    expect(PatchStorySchema.safeParse({ dedicationText: '\u200C' }).success).toBe(false);
    expect(PatchStorySchema.safeParse({ backCoverBlurb: '\u200D' }).success).toBe(false);
    expect(PatchStorySchema.safeParse({ bookFormat: 'a4' }).success).toBe(false);

    expect(
      PatchStorySchema.safeParse({
        pages: [
          { pageNumber: 1, text: 'A' },
          { pageNumber: 1, text: 'B' },
        ],
      }).success,
    ).toBe(false);

    for (const badNum of [0, 13, 1.5]) {
      expect(
        PatchStorySchema.safeParse({ page: { pageNumber: badNum, text: 'Tekst' } }).success,
      ).toBe(false);
    }
  });
});

describe('7. RuntimeSettingsSchema & PatchSettingsSchema', () => {
  it('validates DEFAULT_RUNTIME_SETTINGS and partial setting updates', () => {
    expect(RuntimeSettingsSchema.parse(DEFAULT_RUNTIME_SETTINGS)).toEqual(
      DEFAULT_RUNTIME_SETTINGS,
    );

    expect(PatchSettingsSchema.safeParse({ activeProvider: 'manual' }).success).toBe(true);
    expect(PatchSettingsSchema.safeParse({ defaultPreviewFirst: true }).success).toBe(true);
    expect(
      PatchSettingsSchema.safeParse({
        textModel: 'gemini-3.8-flash',
        imageModel: 'gemini-3-pro-image',
      }).success,
    ).toBe(true);
    expect(
      PatchSettingsSchema.safeParse({
        textModel: 'models/gemini-3.8-flash',
      }).success,
    ).toBe(true);
    expect(PatchSettingsSchema.safeParse({ defaultBookFormat: 'a4-landscape' }).success).toBe(
      true,
    );
  });

  it('rejects empty patches, invalid/traversal model IDs, and unknown providers', () => {
    expect(PatchSettingsSchema.safeParse({}).success).toBe(false);
    expect(PatchSettingsSchema.safeParse({ activeProvider: undefined }).success).toBe(false);
    expect(PatchSettingsSchema.safeParse({ textModel: '' }).success).toBe(false);
    expect(PatchSettingsSchema.safeParse({ textModel: '   ' }).success).toBe(false);
    expect(PatchSettingsSchema.safeParse({ imageModel: '' }).success).toBe(false);
    expect(PatchSettingsSchema.safeParse({ imageModel: 'bad model name' }).success).toBe(false);
    expect(PatchSettingsSchema.safeParse({ activeProvider: 'openai' }).success).toBe(false);

    for (const badModel of [
      'gemini/../../etc/passwd',
      'gemini..evil',
      'gemini//evil',
      'models/gemini-3.8-flash/',
      'gemini/',
    ]) {
      expect(ModelIdSchema.safeParse(badModel).success).toBe(false);
      expect(PatchSettingsSchema.safeParse({ textModel: badModel }).success).toBe(false);
      expect(PatchSettingsSchema.safeParse({ imageModel: badModel }).success).toBe(false);
    }
  });
});

describe('8. StoryRecordSchema & Security Identifiers', () => {
  it('validates complete 10-page StoryRecord fixtures with or without referencePhotos', () => {
    const withRef = makeCompleteStoryRecord();
    expect(StoryRecordSchema.safeParse(withRef).success).toBe(true);

    const withoutRef = makeCompleteStoryRecord({ referencePhotos: [] });
    expect(StoryRecordSchema.safeParse(withoutRef).success).toBe(true);

    const withOffsetTimestamp = makeCompleteStoryRecord({
      createdAt: '2026-11-25T19:30:00+01:00',
      updatedAt: '2026-11-25T19:35:00+01:00',
    });
    expect(StoryRecordSchema.safeParse(withOffsetTimestamp).success).toBe(true);
  });

  it('rejects traversal identifiers, bad asset filenames, bad demo paths, bad array lengths, and malformed timestamps', () => {
    for (const badId of ['../evil', 'a/b', 'ab']) {
      expect(StoryIdSchema.safeParse(badId).success).toBe(false);
      expect(StoryRecordSchema.safeParse(makeCompleteStoryRecord({ id: badId })).success).toBe(
        false,
      );
    }

    for (const badFile of ['../secret.jpg', 'a..b.jpg', 'evil.svg', 'photo.jpg\0.png']) {
      expect(AssetFilenameSchema.safeParse(badFile).success).toBe(false);
      expect(
        StoryRecordSchema.safeParse(makeCompleteStoryRecord({ coverFilename: badFile })).success,
      ).toBe(false);
      expect(
        StoryRecordSchema.safeParse(makeCompleteStoryRecord({ referencePhotos: [badFile] }))
          .success,
      ).toBe(false);
    }

    for (const badDemo of ['/demo-art/../etc/passwd.jpg', 'https://evil.com/x.jpg']) {
      expect(
        StoryRecordSchema.safeParse(makeCompleteStoryRecord({ demoCoverPath: badDemo })).success,
      ).toBe(false);
    }

    expect(
      StoryRecordSchema.safeParse(
        makeCompleteStoryRecord({
          referencePhotos: ['ref-1.jpg', 'ref-2.jpg', 'ref-3.jpg', 'ref-4.jpg', 'ref-5.jpg'],
        }),
      ).success,
    ).toBe(false);

    const base = makeCompleteStoryRecord();
    expect(
      StoryRecordSchema.safeParse(makeCompleteStoryRecord({ pages: base.pages.slice(0, 3) }))
        .success,
    ).toBe(false);
    expect(
      StoryRecordSchema.safeParse(
        makeCompleteStoryRecord({
          pages: [
            ...base.pages,
            { ...base.pages[0], pageNumber: 11 },
            { ...base.pages[0], pageNumber: 12 },
            { ...base.pages[0], pageNumber: 12 },
          ],
        }),
      ).success,
    ).toBe(false);

    expect(
      StoryRecordSchema.safeParse(makeCompleteStoryRecord({ createdAt: 'not-a-timestamp' }))
        .success,
    ).toBe(false);
  });

  it('enforces unique pageNumbers across StoryRecordSchema and StoryBlueprintSchema and pages.length === input.pageCount', () => {
    const base = makeCompleteStoryRecord();

    // Mismatch: input.pageCount is 10, but only 4 unique pages supplied
    expect(
      StoryRecordSchema.safeParse(
        makeCompleteStoryRecord({ pages: base.pages.slice(0, 4) }),
      ).success,
    ).toBe(false);

    // Matching count (4) with unique pageNumbers succeeds
    expect(
      StoryRecordSchema.safeParse(
        makeCompleteStoryRecord({
          input: { ...base.input, pageCount: 4 },
          pages: base.pages.slice(0, 4),
        }),
      ).success,
    ).toBe(true);

    // Matching count (4) with duplicate pageNumbers fails
    const dupPages = base.pages.slice(0, 4).map((p, idx) => ({
      ...p,
      pageNumber: idx === 1 ? 1 : p.pageNumber,
    }));
    expect(
      StoryRecordSchema.safeParse(
        makeCompleteStoryRecord({
          input: { ...base.input, pageCount: 4 },
          pages: dupPages,
        }),
      ).success,
    ).toBe(false);

    // StoryBlueprintSchema rejects duplicate pageNumbers
    expect(
      StoryBlueprintSchema.safeParse({
        title: base.title,
        subtitle: base.subtitle,
        dedicationText: base.dedicationText,
        backCoverBlurb: base.backCoverBlurb,
        characterBible: base.characterBible,
        coverPrompt: base.coverPrompt,
        pages: dupPages.map(({ pageNumber, chapterTitle, text, imagePrompt }) => ({
          pageNumber,
          chapterTitle,
          text,
          imagePrompt,
        })),
      }).success,
    ).toBe(false);
  });

  it('validates IllustrationSlotSchema strictly', () => {
    for (const validSlot of ['cover', '1', '10', '12']) {
      expect(IllustrationSlotSchema.safeParse(validSlot).success).toBe(true);
    }
    for (const invalidSlot of ['0', '13', '../cover', '01', 'back']) {
      expect(IllustrationSlotSchema.safeParse(invalidSlot).success).toBe(false);
    }
  });
});

describe('9. formatZodIssues', () => {
  it('formats Zod v4 error.issues into path + message objects', () => {
    const result = StoryInputSchema.safeParse({
      ...makeMinimalStoryInput(),
      childAge: 99,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const formatted = formatZodIssues(result.error);
      expect(formatted).toEqual([
        {
          path: 'childAge',
          message: expect.any(String),
        },
      ]);
      expect(formatted[0].message.length).toBeGreaterThan(0);
    }
  });
});

describe('10. M1 Schema Extensions (themeId, StorySummary photo fields, StorageMode, GeminiImageSize)', () => {
  it('accepts valid optional StoryInput.themeId, normalizes blanks to undefined, and rejects invalid slugs', () => {
    const withThemeId = CreateStoryPayloadSchema.parse({
      ...makeMinimalStoryInput(),
      themeId: '  winter-star-express  ',
    });
    expect(withThemeId.themeId).toBe('winter-star-express');
    expect(extractStoryInput(withThemeId).themeId).toBe('winter-star-express');

    const withBlankThemeId = CreateStoryPayloadSchema.parse({
      ...makeMinimalStoryInput(),
      themeId: '   ',
    });
    expect(withBlankThemeId.themeId).toBeUndefined();
    expect('themeId' in extractStoryInput(withBlankThemeId)).toBe(false);

    const withNullThemeId = CreateStoryPayloadSchema.parse({
      ...makeMinimalStoryInput(),
      themeId: null,
    });
    expect(withNullThemeId.themeId).toBeUndefined();

    for (const badSlug of ['UPPERCASE', 'a', '../evil', 'bad slug', '-leading']) {
      expect(
        StoryInputSchema.safeParse({
          ...makeMinimalStoryInput(),
          themeId: badSlug,
        }).success,
      ).toBe(false);
    }
  });

  it('validates StorySummarySchema referencePhotosCount and optional referencePhotosPurgedAt', () => {
    const now = '2026-11-27T10:00:00.000Z';
    const baseSummary: StorySummary = {
      id: 'zosia-summary-01',
      title: 'Zosia i Las',
      subtitle: 'Opowieść',
      childName: 'Zosia',
      childAge: 5,
      gender: 'girl',
      provider: 'demo',
      generationStage: 'complete',
      bookFormat: 'square',
      pageCount: 10,
      coverUrl: '/demo-art/cover.jpg',
      referencePhotosCount: 2,
      createdAt: now,
      updatedAt: now,
    };

    expect(StorySummarySchema.parse(baseSummary)).toEqual(baseSummary);
    expect(
      StorySummarySchema.parse({
        ...baseSummary,
        referencePhotosCount: 0,
        referencePhotosPurgedAt: now,
      }).referencePhotosPurgedAt,
    ).toBe(now);

    expect(
      StorySummarySchema.safeParse({ ...baseSummary, referencePhotosCount: -1 }).success,
    ).toBe(false);
    expect(
      StorySummarySchema.safeParse({ ...baseSummary, referencePhotosCount: 5 }).success,
    ).toBe(false);
    expect(
      StorySummarySchema.safeParse({
        ...baseSummary,
        referencePhotosPurgedAt: 'not-a-timestamp',
      }).success,
    ).toBe(false);
  });

  it('validates StorageModeSchema (including custom) and GeminiImageSizeSchema on RuntimeSettings & PatchSettings', () => {
    expect(STORAGE_MODES).toEqual(['local', 'tmp-fallback', 'custom']);
    for (const mode of STORAGE_MODES) {
      expect(StorageModeSchema.parse(mode)).toBe(mode);
    }

    expect(GEMINI_IMAGE_SIZES).toEqual(['1K', '2K']);
    expect(DEFAULT_GEMINI_IMAGE_SIZE).toBe('1K');
    expect(GeminiImageSizeSchema.parse('1K')).toBe('1K');
    expect(GeminiImageSizeSchema.parse('2K')).toBe('2K');
    for (const bad of ['4K', '1k', '2k', '', 'HD']) {
      expect(GeminiImageSizeSchema.safeParse(bad).success).toBe(false);
    }

    // Legacy 5-field settings without geminiImageSize still parse cleanly
    const legacyParsed = RuntimeSettingsSchema.parse({
      activeProvider: 'demo',
      textModel: 'gemini-3.8-flash',
      imageModel: 'gemini-nano-banana-2.1',
      defaultPreviewFirst: false,
      defaultBookFormat: 'square',
    });
    expect(legacyParsed.geminiImageSize).toBeUndefined();

    // PatchSettings accepts geminiImageSize: '2K' and rejects invalid sizes
    expect(PatchSettingsSchema.parse({ geminiImageSize: '2K' })).toEqual({
      geminiImageSize: '2K',
    });
    expect(PatchSettingsSchema.safeParse({ geminiImageSize: '4K' }).success).toBe(false);
  });
});

