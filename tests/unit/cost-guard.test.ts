import { ApiError } from '@google/genai';
import { describe, expect, it, vi } from 'vitest';
import {
  AIProviderError,
  NON_RETRYABLE_STATUSES,
  estimateStoryCost,
  executeWithoutForbiddenRetries,
  extractHttpStatus,
  planGenerationSlots,
} from '@/lib/ai/cost-guard';

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

describe('estimateStoryCost', () => {
  it('reports strictly free ($0.00 / 0,00 zł, 0 billable images) for demo and manual providers', () => {
    for (const provider of ['demo', 'manual'] as const) {
      for (const generationMode of ['full', 'preview-first'] as const) {
        const estimate = estimateStoryCost({
          provider,
          pageCount: 10,
          generationMode,
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
  });

  it('calculates accurate USD and PLN pricing for gemini-nano-banana-2.1 vs gemini-3-pro-image in full and preview-first modes', () => {
    const nanoFull = estimateStoryCost({
      provider: 'gemini-api',
      pageCount: 10,
      generationMode: 'full',
      imageModel: 'gemini-nano-banana-2.1',
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
