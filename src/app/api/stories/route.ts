import { NextResponse } from 'next/server';
import { AIProviderError, planGenerationSlots } from '@/lib/ai/cost-guard';
import {
  getActiveProviderId,
  getProvider,
  type ReferencePhotoBinary,
} from '@/lib/ai/provider';
import {
  errorResponse,
  getOrCreateRequestId,
  handleApiError,
  jsonResponse,
  toReferencePhotoBinary,
  validateUploadedImageFile,
  type ValidatedUploadedImage,
} from '@/lib/api-helpers';
import {
  extractDiagnosticErrorInfo,
  recordGenerationFailure,
  type DiagnosticStage,
} from '@/lib/ops/diagnostics';
import { getDomainEventBus, getMetricsSink } from '@/lib/ops/event-bus';
import {
  ROUTE_RATE_LIMITS,
  assertContentLengthLimit,
  enforceRateLimit,
  parseJsonBodyWithLimit,
} from '@/lib/security/rate-limit';
import {
  QuotaExceededError,
  releaseDailyQuota,
  reserveDailyQuota,
} from '@/lib/storage/quota';
import { extensionForMime } from '@/lib/storage/security';
import {
  deleteStory,
  generateStoryId,
  getRuntimeSettings,
  getStorageInfo,
  listStories,
  saveStory,
  saveStoryAsset,
} from '@/lib/storage/store';
import {
  CreateStoryPayloadSchema,
  MAX_PHOTO_FILE_BYTES,
  MAX_REFERENCE_PHOTOS,
  MIN_REFERENCE_PHOTOS,
  extractStoryInput,
  type GenerationMode,
  type GenerationStage,
  type ProviderId,
  type StoryPage,
  type StoryRecord,
} from '@/lib/types/story';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_MULTIPART_CREATE_BYTES =
  MAX_REFERENCE_PHOTOS * MAX_PHOTO_FILE_BYTES + 2 * 1024 * 1024;

export async function GET(request?: Request): Promise<NextResponse> {
  const requestId = getOrCreateRequestId(request);
  try {
    const [stories, storage] = await Promise.all([listStories(), getStorageInfo()]);
    return jsonResponse(
      {
        stories,
        storageMode: storage.mode,
      },
      { status: 200, requestId },
    );
  } catch (err) {
    return handleApiError(err, requestId);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const requestId = getOrCreateRequestId(request);
  const startedAt = Date.now();
  let reservedQuota = 0;
  let usedQuota = 0;
  let createdStoryId: string | null = null;
  let activeProviderId: ProviderId | undefined;
  let activeGenerationMode: GenerationMode | undefined;
  let currentStage: DiagnosticStage = 'validation';
  let currentSlot: 'cover' | number | undefined;
  const completedSlots: Array<'cover' | number> = [];

  try {
    await enforceRateLimit(request, ROUTE_RATE_LIMITS.storiesCreate);

    const contentType = request.headers.get('content-type') ?? '';
    let rawPayload: unknown;
    const validatedPhotos: ValidatedUploadedImage[] = [];

    if (contentType.toLowerCase().includes('multipart/form-data')) {
      assertContentLengthLimit(request, MAX_MULTIPART_CREATE_BYTES);
      const formData = await request.formData();
      const payloadEntry = formData.get('payload');
      if (typeof payloadEntry !== 'string' || payloadEntry.trim().length === 0) {
        return errorResponse({
          error: 'Brak pola payload z danymi bajki.',
          code: 'MISSING_PAYLOAD',
          status: 400,
          requestId,
        });
      }
      rawPayload = JSON.parse(payloadEntry);

      const photoEntries = formData.getAll('photos');
      const photoFiles = photoEntries.filter(
        (entry): entry is File => entry instanceof File,
      );

      if (photoFiles.length < MIN_REFERENCE_PHOTOS) {
        return errorResponse({
          error: `Dodaj co najmniej ${MIN_REFERENCE_PHOTOS} zdjęcie dziecka.`,
          code: 'PHOTOS_TOO_FEW',
          status: 400,
          requestId,
        });
      }
      if (photoFiles.length > MAX_REFERENCE_PHOTOS) {
        return errorResponse({
          error: `Możesz przesłać maksymalnie ${MAX_REFERENCE_PHOTOS} zdjęcia dziecka.`,
          code: 'PHOTOS_TOO_MANY',
          status: 400,
          requestId,
        });
      }

      for (const file of photoFiles) {
        validatedPhotos.push(await validateUploadedImageFile(file));
      }
    } else {
      rawPayload = await parseJsonBodyWithLimit(request, 256 * 1024);
    }

    const parsedPayload = CreateStoryPayloadSchema.parse(rawPayload);
    const input = extractStoryInput(parsedPayload);
    const runtimeSettings = await getRuntimeSettings();
    const providerId = parsedPayload.provider ?? getActiveProviderId(runtimeSettings);
    activeProviderId = providerId;
    activeGenerationMode = parsedPayload.generationMode;
    const provider = getProvider(providerId);

    const slotPlan = planGenerationSlots(input.pageCount, parsedPayload.generationMode);
    const immediateSet = new Set<'cover' | number>(slotPlan.immediateSlots);

    if (provider.consumesQuota && slotPlan.imagesNow > 0) {
      currentStage = 'quota';
      await reserveDailyQuota(slotPlan.imagesNow);
      reservedQuota = slotPlan.imagesNow;
    }

    const storyId = generateStoryId(input.childName);
    createdStoryId = storyId;

    const referencePhotoNames: string[] = [];
    const referenceBinaries: ReferencePhotoBinary[] = [];
    for (let i = 0; i < validatedPhotos.length; i += 1) {
      const photo = validatedPhotos[i];
      const filename = `ref-${i + 1}.${photo.ext}`;
      await saveStoryAsset(storyId, filename, photo.buffer);
      referencePhotoNames.push(filename);
      referenceBinaries.push(
        toReferencePhotoBinary(filename, photo.mimeType, photo.buffer),
      );
    }

    currentStage = 'blueprint';
    const blueprint = await provider.generateBlueprint(input, referenceBinaries, {
      textModel: runtimeSettings.textModel,
    });

    const now = new Date().toISOString();
    let coverFilename: string | null = null;
    let demoCoverPath: string | null = null;
    let coverStatus: StoryRecord['coverStatus'] =
      providerId === 'manual' ? 'awaiting-upload' : 'pending';
    let coverUpdatedAt: string | undefined;
    let coverStyleAnchor: ReferencePhotoBinary | null = null;
    let imageModelUsed = provider.defaultModels.imageModel;

    if (immediateSet.has('cover')) {
      currentStage = 'cover';
      currentSlot = 'cover';
      const coverResult = await provider.generateIllustration({
        slot: 'cover',
        prompt: blueprint.coverPrompt,
        characterBible: blueprint.characterBible,
        artStyle: input.artStyle,
        bookFormat: parsedPayload.bookFormat,
        referencePhotos: referenceBinaries,
        totalPages: input.pageCount,
        imageModel: runtimeSettings.imageModel,
      });

      if (coverResult) {
        imageModelUsed = coverResult.modelUsed;
        if (provider.consumesQuota) usedQuota += 1;
        if (coverResult.kind === 'binary' && coverResult.buffer) {
          const ext = extensionForMime(coverResult.mimeType);
          const filename = `cover.${ext}`;
          await saveStoryAsset(storyId, filename, coverResult.buffer);
          coverFilename = filename;
          coverStatus = 'ready';
          coverUpdatedAt = now;
          coverStyleAnchor = toReferencePhotoBinary(
            filename,
            coverResult.mimeType,
            coverResult.buffer,
          );
          completedSlots.push('cover');
        } else if (coverResult.kind === 'demo-asset' && coverResult.demoAssetPath) {
          demoCoverPath = coverResult.demoAssetPath;
          coverStatus = 'ready';
          coverUpdatedAt = now;
          completedSlots.push('cover');
        }
      }
    }

    const pages: StoryPage[] = [];
    for (const bpPage of blueprint.pages) {
      let imageFilename: string | null = null;
      let demoAssetPath: string | null = null;
      let imageStatus: StoryPage['imageStatus'] =
        providerId === 'manual' ? 'awaiting-upload' : 'pending';
      let imageUpdatedAt: string | undefined;

      if (immediateSet.has(bpPage.pageNumber)) {
        currentStage = 'page';
        currentSlot = bpPage.pageNumber;
        const pageArt = await provider.generateIllustration({
          slot: bpPage.pageNumber,
          prompt: bpPage.imagePrompt,
          characterBible: blueprint.characterBible,
          artStyle: input.artStyle,
          bookFormat: parsedPayload.bookFormat,
          referencePhotos: referenceBinaries,
          coverStyleAnchor,
          totalPages: input.pageCount,
          imageModel: runtimeSettings.imageModel,
        });

        if (pageArt) {
          imageModelUsed = pageArt.modelUsed;
          if (provider.consumesQuota) usedQuota += 1;
          if (pageArt.kind === 'binary' && pageArt.buffer) {
            const ext = extensionForMime(pageArt.mimeType);
            const filename = `page-${bpPage.pageNumber}.${ext}`;
            await saveStoryAsset(storyId, filename, pageArt.buffer);
            imageFilename = filename;
            imageStatus = 'ready';
            imageUpdatedAt = now;
            completedSlots.push(bpPage.pageNumber);
          } else if (pageArt.kind === 'demo-asset' && pageArt.demoAssetPath) {
            demoAssetPath = pageArt.demoAssetPath;
            imageStatus = 'ready';
            imageUpdatedAt = now;
            completedSlots.push(bpPage.pageNumber);
          }
        }
      }

      pages.push({
        pageNumber: bpPage.pageNumber,
        chapterTitle: bpPage.chapterTitle,
        text: bpPage.text,
        imagePrompt: bpPage.imagePrompt,
        imageFilename,
        demoAssetPath,
        imageStatus,
        ...(imageUpdatedAt ? { imageUpdatedAt } : {}),
      });
    }

    let generationStage: GenerationStage = 'complete';
    if (providerId === 'manual') {
      generationStage = 'awaiting-manual-art';
    } else if (
      parsedPayload.generationMode === 'preview-first' &&
      slotPlan.deferredSlots.length > 0
    ) {
      generationStage = 'preview';
    }

    const story: StoryRecord = {
      id: storyId,
      createdAt: now,
      updatedAt: now,
      provider: providerId,
      generationMode: parsedPayload.generationMode,
      generationStage,
      bookFormat: parsedPayload.bookFormat,
      input,
      title: blueprint.title,
      subtitle: blueprint.subtitle,
      dedicationText: blueprint.dedicationText,
      backCoverBlurb: blueprint.backCoverBlurb,
      characterBible: blueprint.characterBible,
      coverPrompt: blueprint.coverPrompt,
      coverFilename,
      demoCoverPath,
      coverStatus,
      ...(coverUpdatedAt ? { coverUpdatedAt } : {}),
      referencePhotos: referencePhotoNames,
      pages,
      modelsUsed: {
        textModel:
          providerId === 'gemini-api' || providerId === 'google-subscription'
            ? runtimeSettings.textModel
            : provider.defaultModels.textModel,
        imageModel: imageModelUsed,
      },
    };

    currentStage = 'persistence';
    currentSlot = undefined;
    await saveStory(story);

    // Refund any reserved slots that were not actually consumed
    const unused = Math.max(0, reservedQuota - usedQuota);
    if (unused > 0) {
      await releaseDailyQuota(unused);
      reservedQuota -= unused;
    }

    await getDomainEventBus().publish({
      type: 'story.created',
      occurredAt: now,
      storyId: story.id,
      provider: story.provider,
      pageCount: story.pages.length,
    });
    getMetricsSink().timing('api.stories.create_ms', Date.now() - startedAt, {
      provider: story.provider,
      generationMode: story.generationMode,
    });

    return jsonResponse({ story }, { status: 201, requestId });
  } catch (err) {
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
        operation: 'story.create',
        storyId: createdStoryId ?? undefined,
        provider: activeProviderId,
        generationMode: activeGenerationMode,
        stage: currentStage,
        failedSlot: currentSlot,
        completedSlots,
        ...extractDiagnosticErrorInfo(err),
        durationMs: Date.now() - startedAt,
      });
    }

    if (createdStoryId) {
      await deleteStory(createdStoryId).catch(() => undefined);
    }
    return handleApiError(err, requestId);
  }
}
