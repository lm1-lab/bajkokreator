import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ApiError } from '@google/genai';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GEMINI_IMAGE_SIZE,
  GeminiApiStoryProvider,
  SUPPORTED_GEMINI_IMAGE_SIZES,
  resolveGeminiImageSize,
  type GeminiClientLike,
} from '@/lib/ai/adapters/gemini-api-adapter';
import {
  AIProviderError,
  DEFAULT_PAID_PRICING,
  IMAGE_MODEL_PRICING,
  IMAGE_SIZE_COST_MULTIPLIER,
  NON_RETRYABLE_STATUSES,
  USD_TO_PLN_RATE,
  estimateStoryCost,
  executeWithoutForbiddenRetries,
  extractHttpStatus,
  planGenerationSlots,
  resolveModelPricingTier,
} from '@/lib/ai/cost-guard';
import {
  estimateClientStoryCost,
  IMAGE_MODEL_PRICING as CLIENT_IMAGE_MODEL_PRICING,
  USD_TO_PLN_RATE as CLIENT_USD_TO_PLN_RATE,
} from '@/lib/cost-estimator';
import { resetStorageRootCache } from '@/lib/storage/paths';
import { saveRuntimeSettings } from '@/lib/storage/store';
import type { GeminiImageSize } from '@/lib/types/story';

const originalDataDir = process.env.BAJKOKREATOR_DATA_DIR;
const originalImageSize = process.env.GEMINI_IMAGE_SIZE;
let tempDir = '';

afterEach(async () => {
  if (originalDataDir === undefined) {
    delete process.env.BAJKOKREATOR_DATA_DIR;
  } else {
    process.env.BAJKOKREATOR_DATA_DIR = originalDataDir;
  }
  if (originalImageSize === undefined) {
    delete process.env.GEMINI_IMAGE_SIZE;
  } else {
    process.env.GEMINI_IMAGE_SIZE = originalImageSize;
  }
  resetStorageRootCache();
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = '';
  }
});

describe('planGenerationSlots', () => {
  it('plans full generation (cover + pages 1..N now, 0 later)', () => {
    const plan = planGenerationSlots(10, 'full');
    expect(plan.totalImagesFullBook).toBe(11);
    expect(plan.imagesNow).toBe(11);
    expect(plan.imagesLater).toBe(0);
    expect(plan.immediateSlots).toEqual(['cover', 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(plan.deferredSlots).toEqual([]);
  });

  it('plans preview-first generation (cover + page 1 now, pages 2..N later)', () => {
    const plan = planGenerationSlots(10, 'preview-first');
    expect(plan.totalImagesFullBook).toBe(11);
    expect(plan.imagesNow).toBe(2);
    expect(plan.imagesLater).toBe(9);
    expect(plan.immediateSlots).toEqual(['cover', 1]);
    expect(plan.deferredSlots).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('plans preview-first cleanly for min (4) and max (12) page counts', () => {
    const minPlan = planGenerationSlots(4, 'preview-first');
    expect(minPlan.totalImagesFullBook).toBe(5);
    expect(minPlan.imagesNow).toBe(2);
    expect(minPlan.imagesLater).toBe(3);
    expect(minPlan.deferredSlots).toEqual([2, 3, 4]);

    const maxPlan = planGenerationSlots(12, 'preview-first');
    expect(maxPlan.totalImagesFullBook).toBe(13);
    expect(maxPlan.imagesNow).toBe(2);
    expect(maxPlan.imagesLater).toBe(11);
    expect(maxPlan.deferredSlots).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
});

describe('estimateStoryCost & cost-estimator pricing parity', () => {
  it('shares a single canonical pricing table between cost-estimator.ts and ai/cost-guard.ts', () => {
    expect(IMAGE_MODEL_PRICING).toBe(CLIENT_IMAGE_MODEL_PRICING);
    expect(USD_TO_PLN_RATE).toBe(CLIENT_USD_TO_PLN_RATE);
    expect(IMAGE_SIZE_COST_MULTIPLIER['1K']).toBe(1.0);
    expect(IMAGE_SIZE_COST_MULTIPLIER['2K']).toBeGreaterThan(1.0);
    expect(resolveModelPricingTier('unknown-model', '1K')).toEqual(DEFAULT_PAID_PRICING);
  });

  it('reports strictly free ($0.00 / 0,00 zł, 0 billable images) for demo and manual providers even with 2K', () => {
    for (const provider of ['demo', 'manual'] as const) {
      for (const generationMode of ['full', 'preview-first'] as const) {
        for (const imageSize of ['1K', '2K'] as const) {
          const estimate = estimateStoryCost({
            provider,
            pageCount: 10,
            generationMode,
            imageSize,
          });
          expect(estimate.isFree).toBe(true);
          expect(estimate.billableImagesNow).toBe(0);
          expect(estimate.billableImagesFullBook).toBe(0);
          expect(estimate.estimatedNowUsd).toBe(0);
          expect(estimate.estimatedFullBookUsd).toBe(0);
          expect(estimate.estimatedNowPln).toBe(0);
          expect(estimate.estimatedFullBookPln).toBe(0);
          expect(estimate.formattedNowUsd).toBe('$0.00');
          expect(estimate.formattedFullBookUsd).toBe('$0.00');
          expect(estimate.formattedNowPln).toBe('0,00 zł');
          expect(estimate.formattedFullBookPln).toBe('0,00 zł');
        }
      }
    }
  });

  it('produces identical formatted USD/PLN estimates between estimateClientStoryCost and estimateStoryCost across all models & imageSizes', () => {
    const providers = ['demo', 'manual', 'gemini-api', 'google-subscription'] as const;
    const modes = ['full', 'preview-first'] as const;
    const models = ['gemini-nano-banana-2.1', 'gemini-3-pro-image', 'custom-paid-model'] as const;
    const sizes: readonly GeminiImageSize[] = ['1K', '2K'];

    for (const provider of providers) {
      for (const generationMode of modes) {
        for (const imageModel of models) {
          for (const imageSize of sizes) {
            const clientEst = estimateClientStoryCost({
              provider,
              pageCount: 10,
              generationMode,
              imageModel,
              imageSize,
            });
            const serverEst = estimateStoryCost({
              provider,
              pageCount: 10,
              generationMode,
              imageModel,
              imageSize,
            });

            expect(clientEst.isFree).toBe(serverEst.isFree);
            expect(clientEst.imagesNow).toBe(serverEst.imagesNow);
            expect(clientEst.imagesLater).toBe(serverEst.imagesLater);
            expect(clientEst.totalImagesFullBook).toBe(serverEst.totalImagesFullBook);
            expect(clientEst.formattedNowUsd).toBe(serverEst.formattedNowUsd);
            expect(clientEst.formattedFullBookUsd).toBe(serverEst.formattedFullBookUsd);
            expect(clientEst.formattedNowPln).toBe(serverEst.formattedNowPln);
            expect(clientEst.formattedFullBookPln).toBe(serverEst.formattedFullBookPln);
          }
        }
      }
    }
  });

  it('calculates accurate USD and PLN pricing for gemini-nano-banana-2.1 vs gemini-3-pro-image and 1K vs 2K', () => {
    const nanoFull = estimateStoryCost({
      provider: 'gemini-api',
      pageCount: 10,
      generationMode: 'full',
      imageModel: 'gemini-nano-banana-2.1',
    });
    const nanoFull2K = estimateStoryCost({
      provider: 'gemini-api',
      pageCount: 10,
      generationMode: 'full',
      imageModel: 'gemini-nano-banana-2.1',
      imageSize: '2K',
    });
    const nanoPreview = estimateStoryCost({
      provider: 'gemini-api',
      pageCount: 10,
      generationMode: 'preview-first',
      imageModel: 'gemini-nano-banana-2.1',
    });
    const proFull = estimateStoryCost({
      provider: 'gemini-api',
      pageCount: 10,
      generationMode: 'full',
      imageModel: 'gemini-3-pro-image',
    });
    const subscriptionPreview = estimateStoryCost({
      provider: 'google-subscription',
      pageCount: 10,
      generationMode: 'preview-first',
      imageModel: 'gemini-nano-banana-2.1',
    });

    expect(nanoFull.isFree).toBe(false);
    expect(nanoFull.totalImagesFullBook).toBe(11);
    expect(nanoFull.billableImagesNow).toBe(11);
    expect(nanoFull.imagesLater).toBe(0);
    expect(nanoFull.estimatedNowUsd).toBeGreaterThan(0);
    expect(nanoFull.estimatedNowUsd).toBe(nanoFull.estimatedFullBookUsd);
    expect(nanoFull.formattedNowUsd).toMatch(/^\$\d+\.\d{2}$/);
    expect(nanoFull.formattedNowPln).toMatch(/^\d+,\d{2} zł$/);

    expect(nanoFull2K.estimatedFullBookUsd).toBeGreaterThan(nanoFull.estimatedFullBookUsd);
    expect(nanoFull2K.estimatedFullBookPln).toBeGreaterThan(nanoFull.estimatedFullBookPln);

    expect(nanoPreview.imagesNow).toBe(2);
    expect(nanoPreview.imagesLater).toBe(9);
    expect(nanoPreview.billableImagesNow).toBe(2);
    expect(nanoPreview.estimatedNowUsd).toBeLessThan(nanoPreview.estimatedFullBookUsd);
    expect(nanoPreview.estimatedFullBookUsd).toBe(nanoFull.estimatedFullBookUsd);

    expect(proFull.estimatedFullBookUsd).toBeGreaterThan(nanoFull.estimatedFullBookUsd);
    expect(proFull.estimatedFullBookPln).toBeGreaterThan(nanoFull.estimatedFullBookPln);

    expect(subscriptionPreview.isFree).toBe(false);
    expect(subscriptionPreview.imagesNow).toBe(2);
    expect(subscriptionPreview.imagesLater).toBe(9);
    expect(subscriptionPreview.note).toContain('subskrypcji');
  });
});

describe('Gemini imageSize configuration & browser-safe leaf module guards', () => {
  it('resolves Gemini imageSize across explicit option, env var, and persisted runtime settings without outputMimeType/personGeneration', async () => {
    expect(DEFAULT_GEMINI_IMAGE_SIZE).toBe('1K');
    expect(SUPPORTED_GEMINI_IMAGE_SIZES).toEqual(['1K', '2K']);
    expect(resolveGeminiImageSize('2K', {})).toBe('2K');
    expect(resolveGeminiImageSize(undefined, { GEMINI_IMAGE_SIZE: '2K' })).toBe('2K');
    expect(resolveGeminiImageSize('4K', { GEMINI_IMAGE_SIZE: 'invalid' })).toBe('1K');

    const jpegBuf = await sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: 220, g: 190, b: 150 } },
    })
      .jpeg()
      .toBuffer();

    const makeMockClient = () => {
      const capturedConfigs: Array<Record<string, unknown>> = [];
      const client: GeminiClientLike = {
        models: {
          generateContent: vi.fn(async (params: unknown) => {
            const p = params as { config?: Record<string, unknown> };
            capturedConfigs.push(p.config ?? {});
            return {
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        inlineData: {
                          mimeType: 'image/jpeg',
                          data: jpegBuf.toString('base64'),
                        },
                      },
                    ],
                  },
                },
              ],
            } as unknown as Awaited<ReturnType<GeminiClientLike['models']['generateContent']>>;
          }) as GeminiClientLike['models']['generateContent'],
        },
      };
      return { client, capturedConfigs };
    };

    const baseReq = {
      slot: 'cover' as const,
      prompt: 'Watercolor cover of Zosia in a forest',
      characterBible: 'Zosia, 5yo girl',
      artStyle: 'watercolor' as const,
      bookFormat: 'square' as const,
      referencePhotos: [],
    };

    // 1. Explicit adapter option imageSize: '2K'
    const mock1 = makeMockClient();
    const providerExplicit = new GeminiApiStoryProvider({
      imageSize: '2K',
      env: {},
      createClient: () => mock1.client,
    });
    await providerExplicit.generateIllustration(baseReq);
    expect(mock1.capturedConfigs[0]?.imageConfig).toEqual({
      aspectRatio: '1:1',
      imageSize: '2K',
    });
    expect(mock1.capturedConfigs[0]?.imageConfig).not.toHaveProperty('outputMimeType');
    expect(mock1.capturedConfigs[0]?.imageConfig).not.toHaveProperty('personGeneration');

    // 2. Custom isolated env GEMINI_IMAGE_SIZE: '2K'
    const mock2 = makeMockClient();
    const providerEnv = new GeminiApiStoryProvider({
      env: { GEMINI_IMAGE_SIZE: '2K' },
      createClient: () => mock2.client,
    });
    await providerEnv.generateIllustration(baseReq);
    expect(mock2.capturedConfigs[0]?.imageConfig).toEqual({
      aspectRatio: '1:1',
      imageSize: '2K',
    });

    // 3. Default process.env mode reads persisted RuntimeSettings.geminiImageSize
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bajkokreator-imgsize-test-'));
    process.env.BAJKOKREATOR_DATA_DIR = tempDir;
    delete process.env.GEMINI_IMAGE_SIZE;
    resetStorageRootCache();
    await saveRuntimeSettings({ geminiImageSize: '2K' });

    const mock3 = makeMockClient();
    const providerRuntime = new GeminiApiStoryProvider({
      createClient: () => mock3.client,
    });
    await providerRuntime.generateIllustration(baseReq);
    expect(mock3.capturedConfigs[0]?.imageConfig).toEqual({
      aspectRatio: '1:1',
      imageSize: '2K',
    });
  });

  it('keeps browser-safe leaf modules free of node:* and server SDK imports', async () => {
    const leafFiles = [
      'src/lib/types/story.ts',
      'src/lib/cost-estimator.ts',
      'src/lib/ops/logger.ts',
    ];
    for (const relPath of leafFiles) {
      const content = await fs.readFile(path.resolve(process.cwd(), relPath), 'utf8');
      expect(content).not.toMatch(/from\s+['"]node:/);
      expect(content).not.toMatch(/from\s+['"]@google\/genai['"]/);
      expect(content).not.toMatch(/from\s+['"]sharp['"]/);
    }
  });
});

describe('executeWithoutForbiddenRetries & HTTP status guard', () => {
  it('contains 400, 401, 402, 403 in NON_RETRYABLE_STATUSES', () => {
    expect(NON_RETRYABLE_STATUSES.has(400)).toBe(true);
    expect(NON_RETRYABLE_STATUSES.has(401)).toBe(true);
    expect(NON_RETRYABLE_STATUSES.has(402)).toBe(true);
    expect(NON_RETRYABLE_STATUSES.has(403)).toBe(true);
    expect(NON_RETRYABLE_STATUSES.has(500)).toBe(false);
  });

  it('invokes fn strictly ONCE (zero retries) and throws non-retryable Polish AIProviderError for real ApiError 400/401/402/403', async () => {
    const statuses = [400, 401, 402, 403] as const;

    for (const status of statuses) {
      const apiErr = new ApiError({
        message: `Simulated upstream HTTP ${status}`,
        status,
      });
      expect(extractHttpStatus(apiErr)).toBe(status);

      const fn = vi.fn<() => Promise<string>>().mockRejectedValue(apiErr);

      let caught: unknown;
      try {
        await executeWithoutForbiddenRetries(fn, { providerId: 'gemini-api' });
      } catch (err: unknown) {
        caught = err;
      }

      expect(fn).toHaveBeenCalledTimes(1);
      expect(caught).toBeInstanceOf(AIProviderError);
      const providerErr = caught as AIProviderError;
      expect(providerErr.httpStatus).toBe(status);
      expect(providerErr.retryable).toBe(false);
      expect(providerErr.providerId).toBe('gemini-api');
      expect(providerErr.message).toContain(`HTTP ${status}`);
    }
  });

  it('returns result directly on success with strictly 1 invocation', async () => {
    const fn = vi.fn<() => Promise<string>>().mockResolvedValue('ok');
    const result = await executeWithoutForbiddenRetries(fn, {
      providerId: 'gemini-api',
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
