import { NextResponse } from 'next/server';
import {
  errorResponse,
  getOrCreateRequestId,
  handleApiError,
  jsonResponse,
} from '@/lib/api-helpers';
import { getDomainEventBus } from '@/lib/ops/event-bus';
import { assertValidStoryId } from '@/lib/storage/security';
import { purgeStoryReferencePhotos } from '@/lib/storage/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GDPR/RODO retention helper: permanently deletes uploaded reference child photos
 * associated with a story while preserving the generated storybook and illustrations.
 */
export async function DELETE(
  request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  const requestId = getOrCreateRequestId(request);
  try {
    const { id } = await context.params;
    const safeId = assertValidStoryId(id);

    const result = await purgeStoryReferencePhotos(safeId);
    if (!result) {
      return errorResponse({
        error: 'Nie znaleziono bajki o podanym identyfikatorze.',
        code: 'NOT_FOUND',
        status: 404,
        requestId,
      });
    }

    if (!result.alreadyPurged || result.deletedFiles.length > 0) {
      await getDomainEventBus().publish({
        type: 'story.reference_photos_purged',
        occurredAt: result.purgedAt,
        storyId: result.storyId,
        deletedCount: result.deletedFiles.length,
      });
    }

    return jsonResponse(
      {
        purged: true,
        ...result,
      },
      { status: 200, requestId },
    );
  } catch (err) {
    return handleApiError(err, requestId);
  }
}
