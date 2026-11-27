import { GoogleGenAI, Modality, type Part } from '@google/genai';
import sharp from 'sharp';
import { z } from 'zod';
import {
  AIProviderError,
  executeWithoutForbiddenRetries,
} from '@/lib/ai/cost-guard';
import type {
  BlueprintGenerationOptions,
  GeneratedIllustration,
  IllustrationRequest,
  ProviderStatus,
  ReferencePhotoBinary,
  StoryProvider,
} from '@/lib/ai/provider';
import {
  PRINT_SAFETY_CLAUSE,
  buildGeminiBlueprintSystemInstruction,
  buildGeminiBlueprintUserPrompt,
  buildGeminiImagePrompt,
} from '@/lib/polish/prompts';
import { detectImageMime } from '@/lib/storage/security';
import { getRuntimeSettings } from '@/lib/storage/store';
import {
  DEFAULT_GEMINI_IMAGE_SIZE,
  GEMINI_IMAGE_SIZES,
  GeminiImageSizeSchema,
  MAX_PAGE_COUNT,
  MIN_PAGE_COUNT,
  ModelIdSchema,
  StoryBlueprintSchema,
  type AuthStrategy,
  type BookFormat,
  type GeminiImageSize,
  type ProviderId,
  type StoryBlueprint,
  type StoryInput,
} from '@/lib/types/story';

// =============================================================================
// Gemini API Adapter (@google/genai@3.6.1)
// Text: gemini-3.8-flash | Images: gemini-nano-banana-2.1 / gemini-3-pro-image
// =============================================================================

export const DEFAULT_GEMINI_TEXT_MODEL = 'gemini-3.8-flash';
export const DEFAULT_GEMINI_IMAGE_MODEL = 'gemini-nano-banana-2.1';
export const SUPPORTED_GEMINI_IMAGE_MODELS = [
  'gemini-nano-banana-2.1',
  'gemini-3-pro-image',
] as const;
export { DEFAULT_GEMINI_IMAGE_SIZE };
export const SUPPORTED_GEMINI_IMAGE_SIZES = GEMINI_IMAGE_SIZES;

export const GEMINI_HTTP_TIMEOUT_MS = 60_000;

export interface GeminiClientLike {
  models: {
    generateContent: GoogleGenAI['models']['generateContent'];
  };
}

export type GeminiClientFactory = () => GeminiClientLike;

export interface GeminiAdapterOptions {
  providerId?: ProviderId;
  name?: string;
  authStrategy?: AuthStrategy | 'none';
  apiKey?: string;
  textModel?: string;
  imageModel?: string;
  imageSize?: GeminiImageSize;
  env?: Record<string, string | undefined>;
  createClient?: GeminiClientFactory;
  statusResolver?: () => ProviderStatus;
}

export function resolveGeminiImageSize(
  candidate?: string,
  env: Record<string, string | undefined> = process.env,
): GeminiImageSize {
  const trimmedCandidate = candidate?.trim();
  if (trimmedCandidate) {
    const parsedCandidate = GeminiImageSizeSchema.safeParse(trimmedCandidate);
    if (parsedCandidate.success) {
      return parsedCandidate.data;
    }
  }

  const trimmedEnv = env.GEMINI_IMAGE_SIZE?.trim();
  if (trimmedEnv) {
    const parsedEnv = GeminiImageSizeSchema.safeParse(trimmedEnv);
    if (parsedEnv.success) {
      return parsedEnv.data;
    }
  }

  return DEFAULT_GEMINI_IMAGE_SIZE;
}

export function resolveGeminiModels(
  env: Record<string, string | undefined> = process.env,
): { textModel: string; imageModel: string } {
  const rawText = env.GEMINI_TEXT_MODEL?.trim();
  const rawImage = env.GEMINI_IMAGE_MODEL?.trim();

  const textParsed = rawText ? ModelIdSchema.safeParse(rawText) : null;
  const imageParsed = rawImage ? ModelIdSchema.safeParse(rawImage) : null;

  return {
    textModel: textParsed?.success ? textParsed.data : DEFAULT_GEMINI_TEXT_MODEL,
    imageModel: imageParsed?.success ? imageParsed.data : DEFAULT_GEMINI_IMAGE_MODEL,
  };
}

export function buildBlueprintResponseJsonSchema(
  pageCount: number,
): Record<string, unknown> {
  const safePageCount = Math.min(
    MAX_PAGE_COUNT,
    Math.max(MIN_PAGE_COUNT, Math.floor(pageCount)),
  );
  const generated = JSON.parse(
    JSON.stringify(z.toJSONSchema(StoryBlueprintSchema)),
  ) as Record<string, unknown>;

  delete generated.$schema;

  const properties = generated.properties as Record<string, unknown> | undefined;
  const pagesSchema = properties?.pages as Record<string, unknown> | undefined;
  if (pagesSchema && typeof pagesSchema === 'object') {
    pagesSchema.minItems = safePageCount;
    pagesSchema.maxItems = safePageCount;
  }

  return generated;
}

function resolveAspectRatio(bookFormat: BookFormat): '1:1' | '4:3' {
  return bookFormat === 'a4-landscape' ? '4:3' : '1:1';
}

function stripMarkdownFences(raw: string): string {
  const trimmed = raw.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

function ensurePrintSafetyClause(prompt: string): string {
  const trimmed = prompt.trim();
  if (trimmed.toLowerCase().includes(PRINT_SAFETY_CLAUSE.toLowerCase())) {
    return trimmed.length <= 4000 ? trimmed : trimmed.slice(0, 4000).trimEnd();
  }
  const suffix = `\n[PRINT SAFETY] ${PRINT_SAFETY_CLAUSE}.`;
  const maxPrefix = 4000 - suffix.length;
  const prefix =
    trimmed.length <= maxPrefix
      ? trimmed
      : `${trimmed.slice(0, Math.max(1, maxPrefix - 1)).trimEnd()}…`;
  return `${prefix}${suffix}`;
}

function pickValidModelId(candidate: string | undefined, fallback: string): string {
  if (!candidate) {
    return fallback;
  }
  const parsed = ModelIdSchema.safeParse(candidate);
  return parsed.success ? parsed.data : fallback;
}

export class GeminiApiStoryProvider implements StoryProvider {
  readonly id: ProviderId;
  readonly name: string;
  readonly authStrategy: AuthStrategy | 'none';
  readonly consumesQuota = true;

  private readonly env: Record<string, string | undefined>;
  private readonly usesProcessEnv: boolean;
  private readonly explicitApiKey?: string;
  private readonly explicitTextModel?: string;
  private readonly explicitImageModel?: string;
  private readonly explicitImageSize?: GeminiImageSize;
  private readonly createClient?: GeminiClientFactory;
  private readonly statusResolver?: () => ProviderStatus;

  constructor(options: GeminiAdapterOptions = {}) {
    this.id = options.providerId ?? 'gemini-api';
    this.name = options.name ?? 'Google Gemini API';
    this.authStrategy = options.authStrategy ?? 'api_key';
    this.env = options.env ?? process.env;
    this.usesProcessEnv = !options.env || options.env === process.env;
    this.explicitApiKey = options.apiKey;
    this.explicitTextModel = options.textModel;
    this.explicitImageModel = options.imageModel;
    this.explicitImageSize = options.imageSize;
    this.createClient = options.createClient;
    this.statusResolver = options.statusResolver;
  }

  private async resolveEffectiveImageSize(): Promise<GeminiImageSize> {
    if (this.explicitImageSize) {
      return resolveGeminiImageSize(this.explicitImageSize, this.env);
    }

    if (this.usesProcessEnv) {
      try {
        const settings = await getRuntimeSettings();
        return resolveGeminiImageSize(settings.geminiImageSize, this.env);
      } catch {
        return resolveGeminiImageSize(undefined, this.env);
      }
    }

    return resolveGeminiImageSize(undefined, this.env);
  }

  get defaultModels(): { textModel: string; imageModel: string } {
    const resolved = resolveGeminiModels(this.env);
    return {
      textModel: pickValidModelId(this.explicitTextModel, resolved.textModel),
      imageModel: pickValidModelId(this.explicitImageModel, resolved.imageModel),
    };
  }

  private getApiKey(): string | null {
    const raw = (this.explicitApiKey ?? this.env.GEMINI_API_KEY ?? '').trim();
    return raw.length > 0 ? raw : null;
  }

  private resolveClient(): GeminiClientLike {
    if (this.createClient) {
      return this.createClient();
    }

    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new AIProviderError(
        'Brak skonfigurowanego klucza GEMINI_API_KEY. Dodaj klucz w pliku .env lub przełącz dostawcę na Tryb Demo / Tryb Ręczny.',
        {
          httpStatus: 401,
          retryable: false,
          code: 'GEMINI_API_KEY_MISSING',
          providerId: this.id,
        },
      );
    }

    return new GoogleGenAI({
      apiKey,
      httpOptions: {
        retryOptions: { attempts: 1 },
        timeout: GEMINI_HTTP_TIMEOUT_MS,
      },
    });
  }

  getStatus(): ProviderStatus {
    if (this.statusResolver) {
      return this.statusResolver();
    }

    const configured = Boolean(this.createClient || this.getApiKey());
    return {
      id: this.id,
      name: this.name,
      authStrategy: this.authStrategy,
      consumesQuota: this.consumesQuota,
      configured,
      available: configured,
      description: configured
        ? 'Połączono z Google Gemini API (tekst: gemini-3.8-flash, ilustracje: gemini-nano-banana-2.1 / gemini-3-pro-image) z bezpiecznikiem braku ponowień dla 400/402/403.'
        : 'Wymaga ustawienia zmiennej środowiskowej GEMINI_API_KEY. Obsługuje gemini-3.8-flash oraz gemini-nano-banana-2.1 / gemini-3-pro-image z kotwicą stylu okładki.',
      defaultModels: this.defaultModels,
    };
  }

  async generateBlueprint(
    input: StoryInput,
    referencePhotos: ReferencePhotoBinary[],
    options?: BlueprintGenerationOptions,
  ): Promise<StoryBlueprint> {
    const client = this.resolveClient();
    const model = pickValidModelId(options?.textModel, this.defaultModels.textModel);

    const parts: Part[] = [];
    for (const photo of referencePhotos) {
      parts.push({
        inlineData: {
          mimeType: photo.mimeType,
          data: photo.buffer.toString('base64'),
        },
      });
    }
    parts.push({
      text: buildGeminiBlueprintUserPrompt(input, referencePhotos.length),
    });

    const response = await executeWithoutForbiddenRetries(
      () =>
        client.models.generateContent({
          model,
          contents: parts,
          config: {
            systemInstruction: buildGeminiBlueprintSystemInstruction(input),
            temperature: 0.7,
            responseMimeType: 'application/json',
            responseJsonSchema: buildBlueprintResponseJsonSchema(input.pageCount),
            automaticContinuation: false,
          },
        }),
      { providerId: this.id },
    );

    const rawText = response.text?.trim();
    if (!rawText) {
      throw new AIProviderError(
        'Model Gemini zwrócił pustą odpowiedź podczas tworzenia scenariusza bajki.',
        {
          httpStatus: 502,
          retryable: false,
          code: 'GEMINI_EMPTY_BLUEPRINT',
          providerId: this.id,
        },
      );
    }

    let jsonData: unknown;
    try {
      jsonData = JSON.parse(stripMarkdownFences(rawText));
    } catch (err: unknown) {
      throw new AIProviderError(
        'Model Gemini zwrócił nieprawidłowy JSON scenariusza bajki.',
        {
          httpStatus: 502,
          retryable: false,
          code: 'GEMINI_INVALID_JSON',
          providerId: this.id,
          cause: err,
        },
      );
    }

    const parsedResult = StoryBlueprintSchema.safeParse(jsonData);
    if (!parsedResult.success) {
      throw new AIProviderError(
        `Scenariusz zwrócony przez Gemini nie spełnia schematu bajki: ${parsedResult.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
        {
          httpStatus: 502,
          retryable: false,
          code: 'GEMINI_INVALID_BLUEPRINT',
          providerId: this.id,
          cause: parsedResult.error,
        },
      );
    }

    const parsed = parsedResult.data;
    const sortedPages = [...parsed.pages].sort(
      (a, b) => a.pageNumber - b.pageNumber,
    );
    const hasExactSequentialPages =
      sortedPages.length === input.pageCount &&
      sortedPages.every((page, idx) => page.pageNumber === idx + 1);

    if (!hasExactSequentialPages) {
      throw new AIProviderError(
        `Model Gemini zwrócił nieprawidłową liczbę lub numerację stron (oczekiwano 1..${input.pageCount}, otrzymano ${sortedPages.length}).`,
        {
          httpStatus: 502,
          retryable: false,
          code: 'GEMINI_INVALID_PAGE_SEQUENCE',
          providerId: this.id,
        },
      );
    }

    return {
      ...parsed,
      coverPrompt: ensurePrintSafetyClause(parsed.coverPrompt),
      pages: sortedPages.map((page) => ({
        ...page,
        imagePrompt: ensurePrintSafetyClause(page.imagePrompt),
      })),
    };
  }

  async generateIllustration(
    req: IllustrationRequest,
  ): Promise<GeneratedIllustration | null> {
    const client = this.resolveClient();
    const model = pickValidModelId(req.imageModel, this.defaultModels.imageModel);
    const aspectRatio = resolveAspectRatio(req.bookFormat);
    const hasCoverStyleAnchor = Boolean(
      req.slot !== 'cover' && req.coverStyleAnchor,
    );

    const parts: Part[] = [];

    if (req.referencePhotos.length > 0) {
      parts.push({
        text: 'Child reference photo(s) for facial likeness, hair, and age accuracy:',
      });
      for (const photo of req.referencePhotos) {
        parts.push({
          inlineData: {
            mimeType: photo.mimeType,
            data: photo.buffer.toString('base64'),
          },
        });
      }
    }

    if (req.slot !== 'cover' && req.coverStyleAnchor) {
      parts.push({
        text: 'COVER STYLE ANCHOR (preserve exact art style, brushwork, palette, and character wardrobe from this cover):',
      });
      parts.push({
        inlineData: {
          mimeType: req.coverStyleAnchor.mimeType,
          data: req.coverStyleAnchor.buffer.toString('base64'),
        },
      });
    }

    parts.push({
      text: buildGeminiImagePrompt({
        slot: req.slot,
        prompt: req.prompt,
        characterBible: req.characterBible,
        artStyle: req.artStyle,
        bookFormat: req.bookFormat,
        hasReferencePhotos: req.referencePhotos.length > 0,
        hasCoverStyleAnchor,
      }),
    });

    const imageSize = await this.resolveEffectiveImageSize();

    const response = await executeWithoutForbiddenRetries(
      () =>
        client.models.generateContent({
          model,
          contents: parts,
          config: {
            responseModalities: [Modality.TEXT, Modality.IMAGE],
            // Gemini Developer API (MLDev) accepts ONLY aspectRatio and imageSize here.
            // NEVER pass outputMimeType or personGeneration (throws synchronously in SDK).
            imageConfig: {
              aspectRatio,
              imageSize,
            },
            automaticContinuation: false,
          },
        }),
      { providerId: this.id },
    );

    const responseParts = response.candidates?.[0]?.content?.parts ?? [];
    const imagePart = responseParts.find(
      (part) =>
        !part.thought &&
        typeof part.inlineData?.data === 'string' &&
        part.inlineData.data.length > 0 &&
        typeof part.inlineData.mimeType === 'string' &&
        part.inlineData.mimeType.startsWith('image/'),
    );

    if (!imagePart?.inlineData?.data || !imagePart.inlineData.mimeType) {
      throw new AIProviderError(
        `Model ${model} nie zwrócił obrazu dla slotu "${String(req.slot)}".`,
        {
          httpStatus: 502,
          retryable: false,
          code: 'GEMINI_NO_IMAGE_RETURNED',
          providerId: this.id,
        },
      );
    }

    const decodedBuffer = Buffer.from(imagePart.inlineData.data, 'base64');
    if (decodedBuffer.length === 0) {
      throw new AIProviderError(
        `Model ${model} zwrócił pusty bufor obrazu dla slotu "${String(req.slot)}".`,
        {
          httpStatus: 502,
          retryable: false,
          code: 'GEMINI_EMPTY_IMAGE',
          providerId: this.id,
        },
      );
    }

    const detectedMime = detectImageMime(decodedBuffer);
    const effectiveMime = detectedMime ?? imagePart.inlineData.mimeType;

    if (effectiveMime === 'image/jpeg' || effectiveMime === 'image/png') {
      return {
        kind: 'binary',
        buffer: decodedBuffer,
        mimeType: effectiveMime,
        modelUsed: model,
      };
    }

    // Transcode WebP or other image formats into JPEG so PDF/storage receive strictly JPEG or PNG.
    const transcoded = await sharp(decodedBuffer).jpeg({ quality: 90 }).toBuffer();
    return {
      kind: 'binary',
      buffer: transcoded,
      mimeType: 'image/jpeg',
      modelUsed: model,
    };
  }
}
