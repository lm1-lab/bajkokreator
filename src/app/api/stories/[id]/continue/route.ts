import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AIProviderError } from '@/lib/ai/cost-guard';
import { getProvider, type ReferencePhotoBinary } from '@/lib/ai/provider';
import {
  errorResponse,
  getOrCreateRequestId,
  handleApiError,
  jsonResponse,
  toReferencePhotoBinary,
} from '@/lib/api-helpers';
import {
  extractDiagnosticErrorInfo,
  recordGenerationFailure,
  type DiagnosticStage,
} from '@/lib/ops/diagnostics';
import {
  ROUTE_RATE_LIMITS,
  enforceRateLimit,
  parseOptionalJsonBodyWithLimit,
} from '@/lib/security/rate-limit';
import {
  QuotaExceededError,
  releaseDailyQuota,
  reserveDailyQuota,
} from '@/lib/storage/quota';
import { assertValidStoryId, extensionForMime } from '@/lib/storage/security';
import {
  getRuntimeSettings,
  getStory,
  readStoryAsset,
  saveStoryAsset,
  updateStory,
} from '@/lib/storage/store';
import type { StoryRecord } from '@/lib/types/story';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const ContinueStoryBodySchema = z.object({
  allowWithoutReferencePhotos: z.boolean().optional(),
});

function isIllustrationReady(status: StoryRecord['coverStatus']): boolean {
  return status === 'ready' || status === 'custom-uploaded';
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  const requestId = getOrCreateRequestId(request);
  const startedAt = Date.now();
  let reservedQuota = 0;
  let usedQuota = 0;
  let safeIdRef: string | undefined;
  let storySnapshot: StoryRecord | null = null;
  const generatedPages: number[] = [];
  let currentStage: DiagnosticStage = 'validation';
  let currentPageNumber: number | undefined;

  try {
    await enforceRateLimit(request, ROUTE_RATE_LIMITS.storiesContinue);

    const { id } = await context.params;
    const safeId = assertValidStoryId(id);
    safeIdRef = safeId;

    let allowWithoutReferencePhotos = false;
    const rawBody = await parseOptionalJsonBodyWithLimit(request, 32 * 1024);
    if (rawBody !== undefined) {
      const parsedBody = ContinueStoryBodySchema.parse(rawBody);
      allowWithoutReferencePhotos = parsedBody.allowWithoutReferencePhotos === true;
    }

    const story = await getStory(safeId);
    if (!story) {
      return errorResponse({
        error: 'Nie znaleziono bajki o podanym identyfikatorze.',
        code: 'NOT_FOUND',
        status: 404,
        requestId,
      });
    }
    storySnapshot = story;

    const pendingPages = story.pages.filter(
      (p) => p.imageStatus === 'pending' || p.imageStatus === 'error',
    );
    if (pendingPages.length === 0) {
      return jsonResponse(
        {
          story: { ...story, generationStage: 'complete' as const },
          generatedPages: [],
        },
        { status: 200, requestId },
      );
    }

    const requiresReferencePhotos = story.provider !== 'manual';
    if (
      story.referencePhotosPurgedAt &&
      requiresReferencePhotos &&
      !allowWithoutReferencePhotos
    ) {
      return errorResponse({
        error:
          'Zdjęcia referencyjne dziecka zostały usunięte (RODO). Przekaż { "allowWithoutReferencePhotos": true }, aby kontynuować generowanie bez zdjęć twarzy.',
        code: 'REFERENCE_PHOTOS_PURGED',
        status: 409,
        requestId,
        details: {
          storyId: safeId,
          provider: story.provider,
          referencePhotosPurgedAt: story.referencePhotosPurgedAt,
        },
      });
    }

    const provider = getProvider(story.provider);
    const runtimeSettings = await getRuntimeSettings();

    if (provider.consumesQuota) {
      currentStage = 'quota';
      await reserveDailyQuota(pendingPages.length);
      reservedQuota = pendingPages.length;
    }

    const referenceBinaries: ReferencePhotoBinary[] = [];
    for (const refName of story.referencePhotos) {
      const asset = await readStoryAsset(safeId, refName);
      if (asset) {
        referenceBinaries.push(
          toReferencePhotoBinary(refName, asset.mimeType, asset.buffer),
        );
      }
    }

    let coverStyleAnchor: ReferencePhotoBinary | null = null;
    if (story.coverFilename) {
      const coverAsset = await readStoryAsset(safeId, story.coverFilename);
      if (coverAsset) {
        coverStyleAnchor = toReferencePhotoBinary(
          story.coverFilename,
          coverAsset.mimeType,
          coverAsset.buffer,
        );
      }
    }

    for (const pending of pendingPages) {
      currentStage = 'page';
      currentPageNumber = pending.pageNumber;

      const art = await provider.generateIllustration({
        slot: pending.pageNumber,
        prompt: pending.imagePrompt,
        characterBible: story.characterBible,
        artStyle: story.input.artStyle,
        bookFormat: story.bookFormat,
        referencePhotos: referenceBinaries,
        coverStyleAnchor,
        totalPages: story.pages.length,
        imageModel: runtimeSettings.imageModel,
      });

      if (art) {
        if (provider.consumesQuota) {
          usedQuota += 1;
        }

        let savedFilename: string | null = null;
        let savedDemoPath: string | null = null;
        if (art.kind === 'binary' && art.buffer) {
          const ext = extensionForMime(art.mimeType);
          const filename = `page-${pending.pageNumber}.${ext}`;
          await saveStoryAsset(safeId, filename, art.buffer);
          savedFilename = filename;
        } else if (art.kind === 'demo-asset' && art.demoAssetPath) {
          savedDemoPath = art.demoAssetPath;
        } else {
          continue;
        }

        // Per-page atomic checkpointing: ensures generated assets are never orphaned
        // and preserves any concurrent edits to story text.
        const pageNow = new Date().toISOString();
        const checkpointed = await updateStory(safeId, (latest) => {
          const idx = latest.pages.findIndex(
            (p) => p.pageNumber === pending.pageNumber,
          );
          if (idx === -1) {
            return latest;
          }
          const updatedPages = [...latest.pages];
          updatedPages[idx] = {
            ...updatedPages[idx],
            ...(savedFilename !== null ? { imageFilename: savedFilename } : {}),
            ...(savedDemoPath !== null ? { demoAssetPath: savedDemoPath } : {}),
            imageStatus: 'ready',
            imageUpdatedAt: pageNow,
          };

          const allReady =
            isIllustrationReady(latest.coverStatus) &&
            updatedPages.every((p) => isIllustrationReady(p.imageStatus));

          return {
            ...latest,
            generationStage: allReady ? 'complete' : latest.generationStage,
            pages: updatedPages,
            updatedAt: pageNow,
          };
        });

        if (checkpointed) {
          storySnapshot = checkpointed;
        }
        generatedPages.push(pending.pageNumber);
      }
    }

    currentPageNumber = undefined;

    const unused = Math.max(0, reservedQuota - usedQuota);
    if (unused > 0) {
      await releaseDailyQuota(unused);
      reservedQuota -= unused;
    }

    const finalStory = (await getStory(safeId)) ?? storySnapshot;
    return jsonResponse(
      {
        story: finalStory,
        generatedPages,
      },
      { status: 200, requestId },
    );
  } catch (err) {
    // Checkpoint failed page status as 'error' while preserving all previously
    // checkpointed 'ready' pages and their assets.
    if (safeIdRef && currentPageNumber !== undefined) {
      const failedPage = currentPageNumber;
      const errNow = new Date().toISOString();
      await updateStory(safeIdRef, (latest) => {
        const idx = latest.pages.findIndex((p) => p.pageNumber === failedPage);
        if (idx === -1 || isIllustrationReady(latest.pages[idx].imageStatus)) {
          return null;
        }
        const updatedPages = [...latest.pages];
        updatedPages[idx] = {
          ...updatedPages[idx],
          imageStatus: 'error',
          imageUpdatedAt: errNow,
        };
        return {
          ...latest,
          pages: updatedPages,
          updatedAt: errNow,
        };
      }).catch(() => undefined);
    }

    const unused = Math.max(0, reservedQuota - usedQuota);
    if (unused > 0) {
      await releaseDailyQuota(unused).catch(() => undefined);
    }

    if (
      currentStage !== 'validation' ||
      err instanceof QuotaExceededError ||
      err instanceof AIProviderError
    ) {
      await recordGenerationFailure({
        requestId,
        operation: 'story.continue',
        storyId: safeIdRef,
        provider: storySnapshot?.provider,
        generationMode: storySnapshot?.generationMode,
        stage: currentStage,
        failedSlot: currentPageNumber,
        completedSlots: generatedPages,
        ...extractDiagnosticErrorInfo(err),
        durationMs: Date.now() - startedAt,
      });
    }

    return handleApiError(err, requestId);
  }
}
