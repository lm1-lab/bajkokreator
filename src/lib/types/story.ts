import { z } from 'zod';

// =============================================================================
// Canonical Constants & Validation Regexes (100% browser-safe leaf module)
// =============================================================================

export const CHILD_GENDERS = ['girl', 'boy'] as const;
export const ART_STYLES = [
  'watercolor',
  'storybook-gouache',
  'vintage-etching',
  'paper-cutout',
] as const;
export const STORY_MOODS = [
  'warm-cozy',
  'magical-adventure',
  'funny-playful',
  'bedtime-calm',
] as const;
export const BOOK_FORMATS = ['square', 'a4-landscape'] as const;
export const PROVIDER_IDS = [
  'demo',
  'manual',
  'gemini-api',
  'google-subscription',
] as const;
export const AUTH_STRATEGIES = ['api_key', 'subscription_oauth_stub'] as const;
export const GENERATION_MODES = ['full', 'preview-first'] as const;
export const GENERATION_STAGES = [
  'complete',
  'preview',
  'awaiting-manual-art',
] as const;
export const IMAGE_STATUSES = [
  'ready',
  'pending',
  'awaiting-upload',
  'custom-uploaded',
  'error',
] as const;
export const STORAGE_MODES = ['local', 'tmp-fallback'] as const;
export const ALLOWED_IMAGE_MIMES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export const MIN_CHILD_AGE = 1;
export const MAX_CHILD_AGE = 12;
export const MIN_PAGE_COUNT = 4;
export const MAX_PAGE_COUNT = 12;
export const DEFAULT_PAGE_COUNT = 10;
export const MIN_REFERENCE_PHOTOS = 1;
export const MAX_REFERENCE_PHOTOS = 4;
export const MAX_PHOTO_FILE_BYTES = 5 * 1024 * 1024; // 5 MiB per file

export const STORY_ID_REGEX = /^[a-z0-9][a-z0-9_-]{3,63}$/;
export const ASSET_FILENAME_REGEX = /^[a-z0-9][a-z0-9_.-]{0,63}\.(jpg|jpeg|png|webp)$/i;
export const DEMO_ASSET_PATH_REGEX =
  /^\/demo-art\/[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*\.(jpg|jpeg|png|webp)$/i;

/** Accepts Polish & Unicode letters, internal ASCII spaces, hyphens, and apostrophes (no leading/trailing separators). */
export const CHILD_NAME_REGEX = /^\p{L}(?:[\p{L} '’-]*\p{L})?$/u;

/** Safe model identifier: alphanumeric start, no whitespace or control characters. */
export const MODEL_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/;

// =============================================================================
// Enum Schemas & Union Types
// =============================================================================

export const ChildGenderSchema = z.enum(
  CHILD_GENDERS,
  'Wybierz płeć dziecka: dziewczynka lub chłopiec.',
);
export const ArtStyleSchema = z.enum(ART_STYLES, 'Wybierz prawidłowy styl ilustracji.');
export const StoryMoodSchema = z.enum(STORY_MOODS, 'Wybierz prawidłowy nastrój bajki.');
export const BookFormatSchema = z.enum(
  BOOK_FORMATS,
  'Wybierz format książki: square lub a4-landscape.',
);
export const ProviderIdSchema = z.enum(PROVIDER_IDS, 'Wybierz prawidłowego dostawcę AI.');
export const AuthStrategySchema = z.enum(
  AUTH_STRATEGIES,
  'Nieprawidłowa strategia autoryzacji.',
);
export const GenerationModeSchema = z.enum(
  GENERATION_MODES,
  'Nieprawidłowy tryb generowania.',
);
export const GenerationStageSchema = z.enum(
  GENERATION_STAGES,
  'Nieprawidłowy etap generowania.',
);
export const ImageStatusSchema = z.enum(
  IMAGE_STATUSES,
  'Nieprawidłowy status ilustracji.',
);
export const StorageModeSchema = z.enum(STORAGE_MODES);
export const AllowedImageMimeSchema = z.enum(
  ALLOWED_IMAGE_MIMES,
  'Dozwolone formaty obrazów to JPEG, PNG oraz WebP.',
);

export type ChildGender = z.infer<typeof ChildGenderSchema>;
export type ArtStyle = z.infer<typeof ArtStyleSchema>;
export type StoryMood = z.infer<typeof StoryMoodSchema>;
export type BookFormat = z.infer<typeof BookFormatSchema>;
export type ProviderId = z.infer<typeof ProviderIdSchema>;
export type AuthStrategy = z.infer<typeof AuthStrategySchema>;
export type GenerationMode = z.infer<typeof GenerationModeSchema>;
export type GenerationStage = z.infer<typeof GenerationStageSchema>;
export type ImageStatus = z.infer<typeof ImageStatusSchema>;
export type StorageMode = z.infer<typeof StorageModeSchema>;
export type AllowedImageMime = z.infer<typeof AllowedImageMimeSchema>;

// =============================================================================
// Reusable Primitive & Security Schemas
// =============================================================================

const IsoTimestampSchema = z.iso.datetime({ offset: true });

export const StoryIdSchema = z
  .string('Identyfikator bajki musi być tekstem.')
  .regex(STORY_ID_REGEX, 'Nieprawidłowy identyfikator bajki.');

export const AssetFilenameSchema = z
  .string('Nazwa pliku musi być tekstem.')
  .regex(ASSET_FILENAME_REGEX, 'Nieprawidłowa nazwa pliku zasobu.')
  .refine((val) => !val.includes('..'), 'Nazwa pliku nie może zawierać sekwencji "..".');

export const DemoAssetPathSchema = z
  .string()
  .regex(DEMO_ASSET_PATH_REGEX, 'Nieprawidłowa ścieżka zasobu demonstracyjnego.');

export const PageNumberSchema = z
  .int('Numer strony musi być liczbą całkowitą.')
  .min(1, 'Numer strony musi wynosić co najmniej 1.')
  .max(MAX_PAGE_COUNT, `Numer strony nie może przekraczać ${MAX_PAGE_COUNT}.`);

export const IllustrationSlotSchema = z.union([
  z.literal('cover'),
  z
    .string()
    .regex(
      /^(?:[1-9]|1[0-2])$/,
      'Slot ilustracji musi mieć wartość "cover" lub numer strony 1–12.',
    ),
]);

export const ModelIdSchema = z
  .string('Identyfikator modelu musi być tekstem.')
  .trim()
  .min(1, 'Identyfikator modelu nie może być pusty.')
  .max(120, 'Identyfikator modelu jest zbyt długi.')
  .regex(MODEL_ID_REGEX, 'Identyfikator modelu zawiera niedozwolone znaki.')
  .refine(
    (val) => !val.includes('..') && !val.includes('//') && !val.endsWith('/'),
    'Identyfikator modelu nie może zawierać sekwencji ".." ani "//".',
  );

const UNICODE_FORMAT_CHARS_REGEX = /\p{Cf}/gu;

function cleanUserText(val: string): string {
  return val.replace(UNICODE_FORMAT_CHARS_REGEX, '').trim().normalize('NFC');
}

function sanitizedTextString(opts: {
  typeError?: string;
  min: number;
  minMessage: string;
  max: number;
  maxMessage: string;
}) {
  const base = opts.typeError ? z.string(opts.typeError) : z.string();
  return base
    .transform(cleanUserText)
    .pipe(z.string().min(opts.min, opts.minMessage).max(opts.max, opts.maxMessage));
}

/**
 * Normalizes optional string fields from HTML forms:
 * - undefined / null / "" / "   " / zero-width format chars -> undefined
 * - "  Mruczek  " -> "Mruczek" (stripped \p{Cf}, trimmed + Unicode NFC)
 * - non-string -> fails with invalid_type
 */
function optionalTrimmedString(maxLen: number, maxMessage: string) {
  return z
    .string()
    .transform(cleanUserText)
    .pipe(z.string().max(maxLen, maxMessage))
    .nullable()
    .transform((val) => (val && val.length > 0 ? val : undefined))
    .optional();
}

// =============================================================================
// Domain Interfaces
// =============================================================================

export interface StoryInput {
  childName: string;
  childAge: number; // 1..12
  gender: ChildGender;
  companion?: string;
  theme: string;
  artStyle: ArtStyle;
  mood: StoryMood;
  pageCount: number; // 4..12, default 10
  dedicationFrom?: string;
}

export interface StoryPage {
  pageNumber: number; // 1..N
  chapterTitle: string;
  text: string;
  imagePrompt: string;
  imageFilename: string | null; // stored in story assets dir (e.g. "page-1.jpg")
  demoAssetPath?: string | null; // e.g. "/demo-art/page-01.jpg"
  imageStatus: ImageStatus;
  imageUpdatedAt?: string;
}

export interface StoryRecord {
  id: string; // matches /^[a-z0-9][a-z0-9_-]{3,63}$/
  createdAt: string;
  updatedAt: string;
  provider: ProviderId;
  generationMode: GenerationMode;
  generationStage: GenerationStage;
  bookFormat: BookFormat;
  input: StoryInput;
  title: string;
  subtitle: string;
  dedicationText: string;
  backCoverBlurb: string;
  characterBible: string;
  coverPrompt: string;
  coverFilename: string | null;
  demoCoverPath?: string | null; // e.g. "/demo-art/cover.jpg"
  coverStatus: ImageStatus;
  coverUpdatedAt?: string;
  referencePhotos: string[]; // 0..4 persisted (1..4 enforced on photo upload batch)
  pages: StoryPage[];
  modelsUsed: {
    textModel: string;
    imageModel: string;
  };
}

export interface StorySummary {
  id: string;
  title: string;
  subtitle: string;
  childName: string;
  childAge: number;
  gender: ChildGender;
  provider: ProviderId;
  generationStage: GenerationStage;
  bookFormat: BookFormat;
  pageCount: number;
  coverUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeSettings {
  activeProvider: ProviderId;
  textModel: string;
  imageModel: string;
  defaultPreviewFirst: boolean;
  defaultBookFormat: BookFormat;
}

export interface StoryBlueprint {
  title: string;
  subtitle: string;
  dedicationText: string;
  backCoverBlurb: string;
  characterBible: string;
  coverPrompt: string;
  pages: Array<{
    pageNumber: number;
    chapterTitle: string;
    text: string;
    imagePrompt: string;
  }>;
}

export interface DailyQuotaStatus {
  date: string;
  used: number;
  limit: number;
  remaining: number;
}

export const DEFAULT_RUNTIME_SETTINGS: RuntimeSettings = {
  activeProvider: 'demo',
  textModel: 'gemini-3.8-flash',
  imageModel: 'gemini-nano-banana-2.1',
  defaultPreviewFirst: false,
  defaultBookFormat: 'square',
};

// =============================================================================
// Core Domain Validation Schemas
// =============================================================================

export const StoryInputSchema = z.object({
  childName: z
    .string('Podaj imię dziecka.')
    .trim()
    .normalize('NFC')
    .min(1, 'Imię dziecka nie może być puste.')
    .max(60, 'Imię dziecka może mieć maksymalnie 60 znaków.')
    .regex(
      CHILD_NAME_REGEX,
      'Imię dziecka powinno składać się z liter (dozwolone polskie znaki, spacja i myślnik).',
    ),
  childAge: z
    .int('Wiek dziecka musi być liczbą całkowitą.')
    .min(MIN_CHILD_AGE, `Wiek dziecka musi wynosić co najmniej ${MIN_CHILD_AGE} rok.`)
    .max(MAX_CHILD_AGE, `Wiek dziecka może wynosić maksymalnie ${MAX_CHILD_AGE} lat.`),
  gender: ChildGenderSchema,
  companion: optionalTrimmedString(80, 'Opis towarzysza może mieć maksymalnie 80 znaków.'),
  theme: sanitizedTextString({
    typeError: 'Opisz temat bajki.',
    min: 3,
    minMessage: 'Temat bajki musi mieć co najmniej 3 znaki.',
    max: 400,
    maxMessage: 'Temat bajki może mieć maksymalnie 400 znaków.',
  }),
  artStyle: ArtStyleSchema,
  mood: StoryMoodSchema,
  pageCount: z
    .int('Liczba stron musi być liczbą całkowitą.')
    .min(MIN_PAGE_COUNT, `Bajka musi mieć co najmniej ${MIN_PAGE_COUNT} strony.`)
    .max(MAX_PAGE_COUNT, `Bajka może mieć maksymalnie ${MAX_PAGE_COUNT} stron.`)
    .default(DEFAULT_PAGE_COUNT),
  dedicationFrom: optionalTrimmedString(
    100,
    'Podpis dedykacji może mieć maksymalnie 100 znaków.',
  ),
});

export const CreateStoryPayloadSchema = StoryInputSchema.extend({
  provider: ProviderIdSchema.optional(),
  generationMode: GenerationModeSchema.default('full'),
  bookFormat: BookFormatSchema.default('square'),
});

export type CreateStoryPayload = z.infer<typeof CreateStoryPayloadSchema>;

/** Photo upload validation (enforces 1..4 photos requirement). */
export const UploadedPhotoMetaSchema = z.object({
  name: z.string().trim().min(1, 'Brak nazwy pliku zdjęcia.').max(255),
  mimeType: AllowedImageMimeSchema,
  sizeBytes: z
    .int('Rozmiar pliku musi być liczbą całkowitą.')
    .min(1, 'Plik zdjęcia nie może być pusty.')
    .max(MAX_PHOTO_FILE_BYTES, 'Pojedyncze zdjęcie może mieć maksymalnie 5 MB.'),
});

export const PhotoBatchSchema = z
  .array(UploadedPhotoMetaSchema, 'Prześlij tablicę zdjęć.')
  .min(MIN_REFERENCE_PHOTOS, `Dodaj co najmniej ${MIN_REFERENCE_PHOTOS} zdjęcie dziecka.`)
  .max(MAX_REFERENCE_PHOTOS, `Możesz dodać maksymalnie ${MAX_REFERENCE_PHOTOS} zdjęcia dziecka.`);

export type UploadedPhotoMeta = z.infer<typeof UploadedPhotoMetaSchema>;

export const PatchPageSchema = z.object({
  text: sanitizedTextString({
    typeError: 'Treść strony musi być tekstem.',
    min: 1,
    minMessage: 'Treść strony nie może być pusta.',
    max: 2000,
    maxMessage: 'Treść strony może mieć maksymalnie 2000 znaków.',
  }),
  chapterTitle: sanitizedTextString({
    typeError: 'Tytuł rozdziału musi być tekstem.',
    min: 1,
    minMessage: 'Tytuł rozdziału nie może być pusty.',
    max: 160,
    maxMessage: 'Tytuł rozdziału może mieć maksymalnie 160 znaków.',
  }).optional(),
});

export type PatchPagePayload = z.infer<typeof PatchPageSchema>;

const PatchStoryPageItemSchema = PatchPageSchema.extend({
  pageNumber: PageNumberSchema,
});

export const PatchStorySchema = z
  .object({
    title: sanitizedTextString({
      min: 1,
      minMessage: 'Tytuł nie może być pusty.',
      max: 160,
      maxMessage: 'Tytuł może mieć maksymalnie 160 znaków.',
    }).optional(),
    subtitle: sanitizedTextString({
      min: 1,
      minMessage: 'Podtytuł nie może być pusty.',
      max: 240,
      maxMessage: 'Podtytuł może mieć maksymalnie 240 znaków.',
    }).optional(),
    dedicationText: sanitizedTextString({
      min: 1,
      minMessage: 'Treść dedykacji nie może być pusta.',
      max: 1200,
      maxMessage: 'Treść dedykacji może mieć maksymalnie 1200 znaków.',
    }).optional(),
    backCoverBlurb: sanitizedTextString({
      min: 1,
      minMessage: 'Opis na tylnej okładce nie może być pusty.',
      max: 1200,
      maxMessage: 'Opis na tylnej okładce może mieć maksymalnie 1200 znaków.',
    }).optional(),
    bookFormat: BookFormatSchema.optional(),
    page: PatchStoryPageItemSchema.optional(),
    pages: z
      .array(PatchStoryPageItemSchema)
      .min(1)
      .max(MAX_PAGE_COUNT)
      .refine(
        (pages) => new Set(pages.map((p) => p.pageNumber)).size === pages.length,
        'Numery stron muszą być unikalne.',
      )
      .optional(),
  })
  .refine(
    (obj) => Object.values(obj).some((val) => val !== undefined),
    'Podaj przynajmniej jedno pole do aktualizacji.',
  );

export type PatchStoryPayload = z.infer<typeof PatchStorySchema>;

export const RuntimeSettingsSchema = z.object({
  activeProvider: ProviderIdSchema,
  textModel: ModelIdSchema,
  imageModel: ModelIdSchema,
  defaultPreviewFirst: z.boolean('Wartość defaultPreviewFirst musi być typu boolean.'),
  defaultBookFormat: BookFormatSchema,
});

export const PatchSettingsSchema = RuntimeSettingsSchema.partial().refine(
  (obj) => Object.values(obj).some((val) => val !== undefined),
  'Podaj przynajmniej jedno ustawienie do aktualizacji.',
);

export type PatchSettingsPayload = z.infer<typeof PatchSettingsSchema>;

export const StoryPageSchema = z.object({
  pageNumber: PageNumberSchema,
  chapterTitle: z.string().trim().min(1).max(160),
  text: z.string().trim().min(1).max(2000),
  imagePrompt: z.string().trim().min(1).max(4000),
  imageFilename: AssetFilenameSchema.nullable(),
  demoAssetPath: DemoAssetPathSchema.nullable().optional(),
  imageStatus: ImageStatusSchema,
  imageUpdatedAt: IsoTimestampSchema.optional(),
});

export const StoryRecordSchema = z.object({
  id: StoryIdSchema,
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  provider: ProviderIdSchema,
  generationMode: GenerationModeSchema,
  generationStage: GenerationStageSchema,
  bookFormat: BookFormatSchema,
  input: StoryInputSchema,
  title: z.string().trim().min(1).max(160),
  subtitle: z.string().trim().min(1).max(240),
  dedicationText: z.string().trim().min(1).max(1200),
  backCoverBlurb: z.string().trim().min(1).max(1200),
  characterBible: z.string().trim().min(1).max(4000),
  coverPrompt: z.string().trim().min(1).max(4000),
  coverFilename: AssetFilenameSchema.nullable(),
  demoCoverPath: DemoAssetPathSchema.nullable().optional(),
  coverStatus: ImageStatusSchema,
  coverUpdatedAt: IsoTimestampSchema.optional(),
  referencePhotos: z.array(AssetFilenameSchema).max(MAX_REFERENCE_PHOTOS),
  pages: z
    .array(StoryPageSchema)
    .min(MIN_PAGE_COUNT)
    .max(MAX_PAGE_COUNT)
    .refine(
      (pages) => new Set(pages.map((p) => p.pageNumber)).size === pages.length,
      'Numery stron muszą być unikalne.',
    ),
  modelsUsed: z.object({
    textModel: ModelIdSchema,
    imageModel: ModelIdSchema,
  }),
}).refine(
  (record) => record.pages.length === record.input.pageCount,
  'Liczba stron musi odpowiadać wartości pageCount.',
);

export const StorySummarySchema = z.object({
  id: StoryIdSchema,
  title: z.string().trim().min(1).max(160),
  subtitle: z.string().trim().min(1).max(240),
  childName: z.string().trim().min(1).max(60),
  childAge: z.int().min(MIN_CHILD_AGE).max(MAX_CHILD_AGE),
  gender: ChildGenderSchema,
  provider: ProviderIdSchema,
  generationStage: GenerationStageSchema,
  bookFormat: BookFormatSchema,
  pageCount: z.int().min(MIN_PAGE_COUNT).max(MAX_PAGE_COUNT),
  coverUrl: z.string().min(1).nullable(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});

export const StoryBlueprintSchema = z.object({
  title: z.string().trim().min(1).max(160),
  subtitle: z.string().trim().min(1).max(240),
  dedicationText: z.string().trim().min(1).max(1200),
  backCoverBlurb: z.string().trim().min(1).max(1200),
  characterBible: z.string().trim().min(1).max(4000),
  coverPrompt: z.string().trim().min(1).max(4000),
  pages: z
    .array(
      z.object({
        pageNumber: PageNumberSchema,
        chapterTitle: z.string().trim().min(1).max(160),
        text: z.string().trim().min(1).max(2000),
        imagePrompt: z.string().trim().min(1).max(4000),
      }),
    )
    .min(MIN_PAGE_COUNT)
    .max(MAX_PAGE_COUNT)
    .refine(
      (pages) => new Set(pages.map((p) => p.pageNumber)).size === pages.length,
      'Numery stron muszą być unikalne.',
    ),
});

// =============================================================================
// Helpers
// =============================================================================

export function extractStoryInput(payload: CreateStoryPayload): StoryInput {
  return {
    childName: payload.childName,
    childAge: payload.childAge,
    gender: payload.gender,
    ...(payload.companion !== undefined ? { companion: payload.companion } : {}),
    theme: payload.theme,
    artStyle: payload.artStyle,
    mood: payload.mood,
    pageCount: payload.pageCount,
    ...(payload.dedicationFrom !== undefined
      ? { dedicationFrom: payload.dedicationFrom }
      : {}),
  };
}

export function formatZodIssues(
  error: z.ZodError,
): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}
