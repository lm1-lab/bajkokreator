import {
  DEFAULT_PAGE_COUNT,
  DEFAULT_RUNTIME_SETTINGS,
  MAX_PAGE_COUNT,
  MIN_PAGE_COUNT,
  type GenerationMode,
  type ProviderId,
} from '@/lib/types/story';

export interface ClientCostEstimate {
  provider: ProviderId;
  generationMode: GenerationMode;
  imageModel: string;
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

const USD_TO_PLN = 4.0;

const PRICING: Readonly<Record<string, { unitImageUsd: number; textUsd: number }>> = {
  'gemini-nano-banana-2.1': { unitImageUsd: 0.039, textUsd: 0.004 },
  'gemini-3-pro-image': { unitImageUsd: 0.134, textUsd: 0.006 },
};

function fmtUsd(v: number): string {
  return `$${(Math.round(v * 100) / 100).toFixed(2)}`;
}

function fmtPln(v: number): string {
  return `${(Math.round(v * 100) / 100).toFixed(2).replace('.', ',')} zł`;
}

export function estimateClientStoryCost(opts: {
  provider: ProviderId;
  pageCount: number;
  generationMode: GenerationMode;
  imageModel?: string;
}): ClientCostEstimate {
  const safePages = Number.isFinite(opts.pageCount)
    ? Math.min(MAX_PAGE_COUNT, Math.max(MIN_PAGE_COUNT, Math.floor(opts.pageCount)))
    : DEFAULT_PAGE_COUNT;
  const totalImagesFullBook = safePages + 1;
  const imagesNow = opts.generationMode === 'preview-first' ? 2 : totalImagesFullBook;
  const imagesLater = Math.max(0, totalImagesFullBook - imagesNow);
  const imageModel = opts.imageModel?.trim() || DEFAULT_RUNTIME_SETTINGS.imageModel;

  if (opts.provider === 'demo' || opts.provider === 'manual') {
    return {
      provider: opts.provider,
      generationMode: opts.generationMode,
      imageModel:
        opts.provider === 'demo' ? 'demo-watercolor-plates-v1' : 'manual-user-upload',
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

  const tier = PRICING[imageModel] ?? { unitImageUsd: 0.06, textUsd: 0.005 };
  const nowUsd = tier.textUsd + imagesNow * tier.unitImageUsd;
  const fullUsd = tier.textUsd + totalImagesFullBook * tier.unitImageUsd;

  return {
    provider: opts.provider,
    generationMode: opts.generationMode,
    imageModel,
    pageCount: safePages,
    isFree: false,
    totalImagesFullBook,
    imagesNow,
    imagesLater,
    formattedNowUsd: fmtUsd(nowUsd),
    formattedFullBookUsd: fmtUsd(fullUsd),
    formattedNowPln: fmtPln(nowUsd * USD_TO_PLN),
    formattedFullBookPln: fmtPln(fullUsd * USD_TO_PLN),
    note:
      opts.provider === 'google-subscription'
        ? `Pula subskrypcji Google AI (${imagesNow} obrazów teraz, ${imagesLater} później; model ${imageModel}).`
        : opts.generationMode === 'preview-first'
          ? `Tryb próbny: najpierw powstanie okładka + 1. strona (${imagesNow} obrazy), resztę (${imagesLater}) dogenerujesz po akceptacji stylu.`
          : `Pełna książka (${totalImagesFullBook} ilustracji: okładka + ${safePages} stron) w modelu ${imageModel}.`,
  };
}
