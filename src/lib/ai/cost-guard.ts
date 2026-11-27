import { ApiError } from '@google/genai';
import {
  DEFAULT_PAID_PRICING,
  IMAGE_MODEL_PRICING,
  IMAGE_SIZE_COST_MULTIPLIER,
  USD_TO_PLN_RATE,
  formatPln,
  formatUsd,
  resolveModelPricingTier,
  roundCurrency,
  type ModelPricingTier,
} from '@/lib/cost-estimator';
import {
  DEFAULT_GEMINI_IMAGE_SIZE,
  DEFAULT_PAGE_COUNT,
  DEFAULT_RUNTIME_SETTINGS,
  MAX_PAGE_COUNT,
  MIN_PAGE_COUNT,
  type GeminiImageSize,
  type GenerationMode,
  type ProviderId,
} from '@/lib/types/story';

export {
  DEFAULT_PAID_PRICING,
  IMAGE_MODEL_PRICING,
  IMAGE_SIZE_COST_MULTIPLIER,
  USD_TO_PLN_RATE,
  formatPln,
  formatUsd,
  resolveModelPricingTier,
  roundCurrency,
  type ModelPricingTier,
};

// =============================================================================
// AI Cost Guards, Pre-Start Cost Estimator, Preview-First Planner & Error Guard
// =============================================================================

/**
 * HTTP status codes that MUST NEVER be retried (invalid request, auth/billing/permission).
 */
export const NON_RETRYABLE_STATUSES: ReadonlySet<number> = new Set([
  400,
  401,
  402,
  403,
]);

export interface AIProviderErrorOptions {
  httpStatus: number;
  retryable: boolean;
  code: string;
  providerId?: ProviderId;
  cause?: unknown;
}

export class AIProviderError extends Error {
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly code: string;
  readonly providerId?: ProviderId;

  constructor(message: string, options: AIProviderErrorOptions) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AIProviderError';
    this.httpStatus = options.httpStatus;
    this.retryable = options.retryable;
    this.code = options.code;
    this.providerId = options.providerId;
    Object.setPrototypeOf(this, AIProviderError.prototype);
  }
}

export interface GenerationSlotPlan {
  pageCount: number;
  generationMode: GenerationMode;
  totalImagesFullBook: number;
  immediateSlots: Array<'cover' | number>;
  deferredSlots: number[];
  imagesNow: number;
  imagesLater: number;
}

function clampPageCount(raw: number): number {
  if (!Number.isFinite(raw)) {
    return DEFAULT_PAGE_COUNT;
  }
  return Math.min(MAX_PAGE_COUNT, Math.max(MIN_PAGE_COUNT, Math.floor(raw)));
}

export function planGenerationSlots(
  pageCount: number,
  generationMode: GenerationMode,
): GenerationSlotPlan {
  const safePages = clampPageCount(pageCount);
  const totalImagesFullBook = safePages + 1; // Cover + Pages 1..N

  if (generationMode === 'preview-first') {
    const immediateSlots: Array<'cover' | number> = ['cover', 1];
    const deferredSlots: number[] = [];
    for (let page = 2; page <= safePages; page += 1) {
      deferredSlots.push(page);
    }
    return {
      pageCount: safePages,
      generationMode,
      totalImagesFullBook,
      immediateSlots,
      deferredSlots,
      imagesNow: immediateSlots.length,
      imagesLater: deferredSlots.length,
    };
  }

  const immediateSlots: Array<'cover' | number> = ['cover'];
  for (let page = 1; page <= safePages; page += 1) {
    immediateSlots.push(page);
  }
  return {
    pageCount: safePages,
    generationMode,
    totalImagesFullBook,
    immediateSlots,
    deferredSlots: [],
    imagesNow: immediateSlots.length,
    imagesLater: 0,
  };
}

export interface CostEstimateOptions {
  provider: ProviderId;
  pageCount: number;
  generationMode: GenerationMode;
  imageModel?: string;
  imageSize?: GeminiImageSize;
}

export interface CostEstimate {
  provider: ProviderId;
  generationMode: GenerationMode;
  imageModel: string;
  imageSize?: GeminiImageSize;
  pageCount: number;
  isFree: boolean;
  totalImagesFullBook: number;
  imagesNow: number;
  imagesLater: number;
  billableImagesNow: number;
  billableImagesFullBook: number;
  unitImageUsd: number;
  estimatedTextUsd: number;
  estimatedNowUsd: number;
  estimatedFullBookUsd: number;
  estimatedNowPln: number;
  estimatedFullBookPln: number;
  formattedNowUsd: string;
  formattedFullBookUsd: string;
  formattedNowPln: string;
  formattedFullBookPln: string;
  note: string;
}

export function estimateStoryCost(opts: CostEstimateOptions): CostEstimate {
  const plan = planGenerationSlots(opts.pageCount, opts.generationMode);
  const imageModel = opts.imageModel?.trim() || DEFAULT_RUNTIME_SETTINGS.imageModel;
  const imageSize = opts.imageSize ?? DEFAULT_GEMINI_IMAGE_SIZE;

  if (opts.provider === 'demo' || opts.provider === 'manual') {
    const note =
      opts.provider === 'demo'
        ? 'Tryb Demo jest całkowicie darmowy — korzysta z wbudowanych akwarelowych ilustracji książkowych i nie zużywa limitu API.'
        : 'Tryb Ręczny jest darmowy — generuje scenariusz i gotowe angielskie prompty pod Nano Banana, a ilustracje wgrywasz ręcznie.';

    return {
      provider: opts.provider,
      generationMode: opts.generationMode,
      imageModel:
        opts.provider === 'demo' ? 'demo-watercolor-plates-v1' : 'manual-user-upload',
      imageSize,
      pageCount: plan.pageCount,
      isFree: true,
      totalImagesFullBook: plan.totalImagesFullBook,
      imagesNow: plan.imagesNow,
      imagesLater: plan.imagesLater,
      billableImagesNow: 0,
      billableImagesFullBook: 0,
      unitImageUsd: 0,
      estimatedTextUsd: 0,
      estimatedNowUsd: 0,
      estimatedFullBookUsd: 0,
      estimatedNowPln: 0,
      estimatedFullBookPln: 0,
      formattedNowUsd: '$0.00',
      formattedFullBookUsd: '$0.00',
      formattedNowPln: '0,00 zł',
      formattedFullBookPln: '0,00 zł',
      note,
    };
  }

  const tier = resolveModelPricingTier(imageModel, imageSize);
  const rawNowUsd = tier.estimatedTextUsd + plan.imagesNow * tier.unitImageUsd;
  const rawFullUsd =
    tier.estimatedTextUsd + plan.totalImagesFullBook * tier.unitImageUsd;
  const estimatedNowUsd = roundCurrency(rawNowUsd);
  const estimatedFullBookUsd = roundCurrency(rawFullUsd);
  const estimatedNowPln = roundCurrency(rawNowUsd * USD_TO_PLN_RATE);
  const estimatedFullBookPln = roundCurrency(rawFullUsd * USD_TO_PLN_RATE);

  const note =
    opts.provider === 'google-subscription'
      ? `Szacunkowa wartość wywołań w puli subskrypcji Google AI (${plan.imagesNow} obrazów teraz, ${plan.imagesLater} później; model ${imageModel}, ${imageSize}). Obowiązuje dzienny limit bezpieczeństwa.`
      : opts.generationMode === 'preview-first'
        ? `Tryb próbny: najpierw powstanie okładka + 1. strona (${plan.imagesNow} obrazy), a pozostałe ${plan.imagesLater} stron wygenerujesz dopiero po akceptacji stylu.`
        : `Pełna książka (${plan.totalImagesFullBook} ilustracji: okładka + ${plan.pageCount} stron) z modelem ${imageModel} (${imageSize}).`;

  return {
    provider: opts.provider,
    generationMode: opts.generationMode,
    imageModel,
    imageSize,
    pageCount: plan.pageCount,
    isFree: false,
    totalImagesFullBook: plan.totalImagesFullBook,
    imagesNow: plan.imagesNow,
    imagesLater: plan.imagesLater,
    billableImagesNow: plan.imagesNow,
    billableImagesFullBook: plan.totalImagesFullBook,
    unitImageUsd: tier.unitImageUsd,
    estimatedTextUsd: tier.estimatedTextUsd,
    estimatedNowUsd,
    estimatedFullBookUsd,
    estimatedNowPln,
    estimatedFullBookPln,
    formattedNowUsd: formatUsd(rawNowUsd),
    formattedFullBookUsd: formatUsd(rawFullUsd),
    formattedNowPln: formatPln(rawNowUsd * USD_TO_PLN_RATE),
    formattedFullBookPln: formatPln(rawFullUsd * USD_TO_PLN_RATE),
    note,
  };
}

// =============================================================================
// HTTP Status Extraction & Non-Retry Guard for 400 / 401 / 402 / 403
// =============================================================================

export function extractHttpStatus(error: unknown, depth = 0): number | null {
  if (depth > 4 || error === null || error === undefined) {
    return null;
  }

  if (error instanceof AIProviderError) {
    return Number.isFinite(error.httpStatus) ? error.httpStatus : null;
  }

  if (error instanceof ApiError) {
    return typeof error.status === 'number' && Number.isFinite(error.status)
      ? error.status
      : null;
  }

  if (typeof error === 'object') {
    const record = error as Record<string, unknown>;
    for (const key of ['httpStatus', 'status', 'statusCode'] as const) {
      const candidate = record[key];
      if (typeof candidate === 'number' && Number.isFinite(candidate)) {
        return candidate;
      }
    }
    if ('cause' in record && record.cause !== undefined) {
      return extractHttpStatus(record.cause, depth + 1);
    }
  }

  return null;
}

function buildNonRetryableError(
  status: number,
  originalError: unknown,
  providerId?: ProviderId,
): AIProviderError {
  const detail =
    originalError instanceof Error && originalError.message.trim().length > 0
      ? ` (${originalError.message.trim().slice(0, 180)})`
      : '';

  switch (status) {
    case 400:
      return new AIProviderError(
        `Dostawca AI odrzucił żądanie (HTTP 400 — nieprawidłowe parametry). Żądanie nie zostało ponowione.${detail}`,
        {
          httpStatus: 400,
          retryable: false,
          code: 'AI_BAD_REQUEST',
          providerId,
          cause: originalError,
        },
      );
    case 401:
      return new AIProviderError(
        `Brak autoryzacji u dostawcy AI (HTTP 401 — sprawdź klucz API lub token). Żądanie nie zostało ponowione.${detail}`,
        {
          httpStatus: 401,
          retryable: false,
          code: 'AI_UNAUTHORIZED',
          providerId,
          cause: originalError,
        },
      );
    case 402:
      return new AIProviderError(
        `Wymagane rozliczenie lub brak środków na koncie dostawcy AI (HTTP 402). Żądanie nie zostało ponowione.${detail}`,
        {
          httpStatus: 402,
          retryable: false,
          code: 'AI_BILLING_REQUIRED',
          providerId,
          cause: originalError,
        },
      );
    case 403:
      return new AIProviderError(
        `Brak uprawnień do wybranego modelu lub projektu AI (HTTP 403). Żądanie nie zostało ponowione.${detail}`,
        {
          httpStatus: 403,
          retryable: false,
          code: 'AI_FORBIDDEN',
          providerId,
          cause: originalError,
        },
      );
    default:
      return new AIProviderError(
        `Błąd dostawcy AI (HTTP ${status}). Żądanie nie zostało ponowione.${detail}`,
        {
          httpStatus: status,
          retryable: false,
          code: 'AI_NON_RETRYABLE',
          providerId,
          cause: originalError,
        },
      );
  }
}

/**
 * Executes an AI provider call strictly ONCE (zero retries) and converts
 * HTTP 400/401/402/403 errors into non-retryable localized AIProviderError instances.
 */
export async function executeWithoutForbiddenRetries<T>(
  fn: () => Promise<T>,
  context?: { providerId?: ProviderId },
): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    const status = extractHttpStatus(err);

    if (status !== null && NON_RETRYABLE_STATUSES.has(status)) {
      if (err instanceof AIProviderError && !err.retryable) {
        throw err;
      }
      throw buildNonRetryableError(status, err, context?.providerId);
    }

    if (err instanceof AIProviderError) {
      throw err;
    }

    if (status !== null) {
      const detail =
        err instanceof Error && err.message.trim().length > 0
          ? `: ${err.message.trim().slice(0, 200)}`
          : '';
      throw new AIProviderError(
        `Błąd połączenia z dostawcą AI (HTTP ${status})${detail}`,
        {
          httpStatus: status,
          retryable: status === 429 || status >= 500,
          code: status === 429 ? 'AI_RATE_LIMITED' : 'AI_UPSTREAM_ERROR',
          providerId: context?.providerId,
          cause: err,
        },
      );
    }

    throw err;
  }
}
