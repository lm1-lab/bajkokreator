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

// =============================================================================
// Canonical Browser-Safe Pricing Constants & Client Cost Estimator
// Single source of truth imported by both client UI and server ai/cost-guard.ts.
// ZERO node:* or server SDK imports allowed in this module.
// =============================================================================

export const USD_TO_PLN_RATE = 4.0;

export interface ModelPricingTier {
  unitImageUsd: number;
  estimatedTextUsd: number;
}

export const IMAGE_MODEL_PRICING: Readonly<Record<string, ModelPricingTier>> = {
  'gemini-nano-banana-2.1': {
    unitImageUsd: 0.039,
    estimatedTextUsd: 0.004,
  },
  'gemini-3-pro-image': {
    unitImageUsd: 0.134,
    estimatedTextUsd: 0.006,
  },
};

export const DEFAULT_PAID_PRICING: ModelPricingTier = {
  unitImageUsd: 0.06,
  estimatedTextUsd: 0.005,
};

export const IMAGE_SIZE_COST_MULTIPLIER: Readonly<Record<GeminiImageSize, number>> = {
  '1K': 1.0,
  '2K': 1.5,
};

export function resolveModelPricingTier(
  imageModel: string,
  imageSize: GeminiImageSize = DEFAULT_GEMINI_IMAGE_SIZE,
): ModelPricingTier {
  const base = IMAGE_MODEL_PRICING[imageModel] ?? DEFAULT_PAID_PRICING;
  const multiplier = IMAGE_SIZE_COST_MULTIPLIER[imageSize] ?? 1.0;
  return {
    unitImageUsd: base.unitImageUsd * multiplier,
    estimatedTextUsd: base.estimatedTextUsd,
  };
}

export function roundCurrency(amount: number): number {
  return Math.round(amount * 100) / 100;
}

export function formatUsd(amount: number): string {
  return `$${roundCurrency(amount).toFixed(2)}`;
}

export function formatPln(amount: number): string {
  return `${roundCurrency(amount).toFixed(2).replace('.', ',')} zł`;
}

export interface ClientCostEstimate {
  provider: ProviderId;
  generationMode: GenerationMode;
  imageModel: string;
  imageSize?: GeminiImageSize;
  pageCount: number;
  isFree: boolean;
  totalImagesFullBook: number;
  imagesNow: number;
  imagesLater: number;
  formattedNowUsd: string;
  formattedFullBookUsd: string;
  formattedNowPln: string;
  formattedFullBookPln: string;
  note: string;
}

export function estimateClientStoryCost(opts: {
  provider: ProviderId;
  pageCount: number;
  generationMode: GenerationMode;
  imageModel?: string;
  imageSize?: GeminiImageSize;
}): ClientCostEstimate {
  const safePages = Number.isFinite(opts.pageCount)
    ? Math.min(MAX_PAGE_COUNT, Math.max(MIN_PAGE_COUNT, Math.floor(opts.pageCount)))
    : DEFAULT_PAGE_COUNT;
  const totalImagesFullBook = safePages + 1;
  const imagesNow = opts.generationMode === 'preview-first' ? 2 : totalImagesFullBook;
  const imagesLater = Math.max(0, totalImagesFullBook - imagesNow);
  const imageModel = opts.imageModel?.trim() || DEFAULT_RUNTIME_SETTINGS.imageModel;
  const imageSize = opts.imageSize ?? DEFAULT_GEMINI_IMAGE_SIZE;

  if (opts.provider === 'demo' || opts.provider === 'manual') {
    return {
      provider: opts.provider,
      generationMode: opts.generationMode,
      imageModel:
        opts.provider === 'demo' ? 'demo-watercolor-plates-v1' : 'manual-user-upload',
      imageSize,
      pageCount: safePages,
      isFree: true,
      totalImagesFullBook,
      imagesNow,
      imagesLater,
      formattedNowUsd: '$0.00',
      formattedFullBookUsd: '$0.00',
      formattedNowPln: '0,00 zł',
      formattedFullBookPln: '0,00 zł',
      note:
        opts.provider === 'demo'
          ? 'Tryb Demo jest w 100% darmowy — od razu tworzy bajkę ze spójnymi akwarelami bez klucza API.'
          : 'Tryb Ręczny jest darmowy — generuje scenariusz i gotowe angielskie prompty pod Nano Banana do wklejenia w Gemini.',
    };
  }

  const tier = resolveModelPricingTier(imageModel, imageSize);
  const nowUsd = tier.estimatedTextUsd + imagesNow * tier.unitImageUsd;
  const fullUsd = tier.estimatedTextUsd + totalImagesFullBook * tier.unitImageUsd;

  return {
    provider: opts.provider,
    generationMode: opts.generationMode,
    imageModel,
    imageSize,
    pageCount: safePages,
    isFree: false,
    totalImagesFullBook,
    imagesNow,
    imagesLater,
    formattedNowUsd: formatUsd(nowUsd),
    formattedFullBookUsd: formatUsd(fullUsd),
    formattedNowPln: formatPln(nowUsd * USD_TO_PLN_RATE),
    formattedFullBookPln: formatPln(fullUsd * USD_TO_PLN_RATE),
    note:
      opts.provider === 'google-subscription'
        ? `Pula subskrypcji Google AI (${imagesNow} obrazów teraz, ${imagesLater} później; model ${imageModel}, ${imageSize}).`
        : opts.generationMode === 'preview-first'
          ? `Tryb próbny: najpierw powstanie okładka + 1. strona (${imagesNow} obrazy), resztę (${imagesLater}) dogenerujesz po akceptacji stylu.`
          : `Pełna książka (${totalImagesFullBook} ilustracji: okładka + ${safePages} stron) w modelu ${imageModel} (${imageSize}).`,
  };
}
