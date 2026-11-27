import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import {
  errorResponse,
  getOrCreateRequestId,
  handleApiError,
  jsonResponse,
  validateUploadedImageFile,
} from '@/lib/api-helpers';
import {
  ROUTE_RATE_LIMITS,
  assertContentLengthLimit,
  enforceRateLimit,
} from '@/lib/security/rate-limit';
import { ASSET_FILENAME_REGEX, assertValidStoryId } from '@/lib/storage/security';
import {
  deleteStoryAsset,
  getStory,
  saveStoryAsset,
  updateStory,
} from '@/lib/storage/store';
import {
  IllustrationSlotSchema,
  MAX_PHOTO_FILE_BYTES,
  type GenerationStage,
  type ImageStatus,
  type StoryRecord,
} from '@/lib/types/story';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string; slot: string }>;
}

function isIllustrationReady(status: ImageStatus): boolean {
  return status === 'ready' || status === 'custom-uploaded';
}

function resolveGenerationStageAfterUpload(story: StoryRecord): GenerationStage {
  const allSlotsReady =
    isIllustrationReady(story.coverStatus) &&
    story.pages.every((page) => isIllustrationReady(page.imageStatus));
  return allSlotsReady ? 'complete' : story.generationStage;
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  const requestId = getOrCreateRequestId(request);
  try {
    await enforceRateLimit(request, ROUTE_RATE_LIMITS.illustrationsUpload);

    const { id, slot: rawSlot } = await context.params;
    const safeId = assertValidStoryId(id);

    const parsedSlot = IllustrationSlotSchema.safeParse(rawSlot);
    if (!parsedSlot.success) {
      return errorResponse({
        error: 'Nieprawidłowy slot ilustracji (oczekiwano "cover" lub numer strony 1–12).',
        code: 'INVALID_SLOT',
        status: 400,
        requestId,
      });
    }

    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('multipart/form-data')) {
      return errorResponse({
        error: 'Oczekiwano żądania typu multipart/form-data z plikiem obrazu.',
        code: 'INVALID_CONTENT_TYPE',
        status: 400,
        requestId,
      });
    }

    assertContentLengthLimit(request, MAX_PHOTO_FILE_BYTES + 1024 * 1024);

    const story = await getStory(safeId);
    if (!story) {
      return errorResponse({
        error: 'Nie znaleziono bajki o podanym identyfikatorze.',
        code: 'NOT_FOUND',
        status: 404,
        requestId,
      });
    }

    const slot = parsedSlot.data;
    if (slot !== 'cover') {
      const pageNum = Number.parseInt(slot, 10);
      const exists = story.pages.some((p) => p.pageNumber === pageNum);
      if (!exists) {
        return errorResponse({
          error: `Strona ${pageNum} nie istnieje w tej bajce.`,
          code: 'PAGE_NOT_FOUND',
          status: 404,
          requestId,
        });
      }
    }

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return errorResponse({
        error: 'Nieprawidłowe dane formularza multipart/form-data.',
        code: 'INVALID_MULTIPART',
        status: 400,
        requestId,
      });
    }

    const fileEntry = formData.get('file');
    if (!(fileEntry instanceof File)) {
      return errorResponse({
        error: 'Brak pliku ilustracji w polu "file".',
        code: 'MISSING_FILE',
        status: 400,
        requestId,
      });
    }

    const validated = await validateUploadedImageFile(fileEntry);
    const stamp = `${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
    const filename =
      slot === 'cover'
        ? `cover-custom-${stamp}.${validated.ext}`
        : `page-${slot}-custom-${stamp}.${validated.ext}`;

    await saveStoryAsset(safeId, filename, validated.buffer);

    const now = new Date().toISOString();
    let previousFilename: string | null = null;
    let updatedStory: StoryRecord | null = null;

    try {
      updatedStory = await updateStory(safeId, (latest) => {
        if (slot === 'cover') {
          previousFilename = latest.coverFilename;
          const candidate: StoryRecord = {
            ...latest,
            coverFilename: filename,
            coverStatus: 'custom-uploaded',
            coverUpdatedAt: now,
            updatedAt: now,
          };
          return {
            ...candidate,
            generationStage: resolveGenerationStageAfterUpload(candidate),
          };
        }

        const pageNum = Number.parseInt(slot, 10);
        const idx = latest.pages.findIndex((p) => p.pageNumber === pageNum);
        if (idx === -1) {
          return null;
        }
        previousFilename = latest.pages[idx].imageFilename;
        const updatedPages = [...latest.pages];
        updatedPages[idx] = {
          ...updatedPages[idx],
          imageFilename: filename,
          imageStatus: 'custom-uploaded',
          imageUpdatedAt: now,
        };
        const candidate: StoryRecord = {
          ...latest,
          pages: updatedPages,
          updatedAt: now,
        };
        return {
          ...candidate,
          generationStage: resolveGenerationStageAfterUpload(candidate),
        };
      });
    } catch (err) {
      await deleteStoryAsset(safeId, filename).catch(() => undefined);
      throw err;
    }

    if (!updatedStory) {
      await deleteStoryAsset(safeId, filename).catch(() => undefined);
      return errorResponse({
        error: 'Nie znaleziono bajki lub wskazanej strony podczas zapisywania ilustracji.',
        code: 'NOT_FOUND',
        status: 404,
        requestId,
      });
    }

    // Delete superseded non-reference custom/generated illustration file to prevent disk orphans
    if (
      previousFilename &&
      previousFilename !== filename &&
      ASSET_FILENAME_REGEX.test(previousFilename) &&
      !/^ref-/i.test(previousFilename)
    ) {
      await deleteStoryAsset(safeId, previousFilename).catch(() => undefined);
    }

    const assetUrl = `/api/stories/${safeId}/assets/${filename}`;
    return jsonResponse(
      {
        slot,
        filename,
        assetUrl,
        updatedAt: now,
        generationStage: updatedStory.generationStage,
      },
      { status: 200, requestId },
    );
  } catch (err) {
    return handleApiError(err, requestId);
  }
}
