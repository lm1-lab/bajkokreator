import { NextResponse } from 'next/server';
import {
  errorResponse,
  getOrCreateRequestId,
  handleApiError,
  jsonResponse,
} from '@/lib/api-helpers';
import { parseJsonBodyWithLimit } from '@/lib/security/rate-limit';
import { assertValidStoryId } from '@/lib/storage/security';
import { deleteStory, getStory, updateStory } from '@/lib/storage/store';
import { PatchStorySchema } from '@/lib/types/story';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  const requestId = getOrCreateRequestId(request);
  try {
    const { id } = await context.params;
    const safeId = assertValidStoryId(id);
    const story = await getStory(safeId);
    if (!story) {
      return errorResponse({
        error: 'Nie znaleziono bajki o podanym identyfikatorze.',
        code: 'NOT_FOUND',
        status: 404,
        requestId,
      });
    }
    return jsonResponse({ story }, { status: 200, requestId });
  } catch (err) {
    return handleApiError(err, requestId);
  }
}

export async function PATCH(
  request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  const requestId = getOrCreateRequestId(request);
  try {
    const { id } = await context.params;
    const safeId = assertValidStoryId(id);

    const rawBody = await parseJsonBodyWithLimit(request, 128 * 1024);
    const patch = PatchStorySchema.parse(rawBody);

    let missingPageNumber: number | null = null;
    const updatedStory = await updateStory(safeId, (story) => {
      const updatedPages = [...story.pages];
      const pageUpdates = [
        ...(patch.page ? [patch.page] : []),
        ...(patch.pages ?? []),
      ];

      for (const item of pageUpdates) {
        const idx = updatedPages.findIndex((p) => p.pageNumber === item.pageNumber);
        if (idx === -1) {
          missingPageNumber = item.pageNumber;
          return null;
        }
        updatedPages[idx] = {
          ...updatedPages[idx],
          text: item.text,
          ...(item.chapterTitle !== undefined ? { chapterTitle: item.chapterTitle } : {}),
        };
      }

      return {
        ...story,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.subtitle !== undefined ? { subtitle: patch.subtitle } : {}),
        ...(patch.dedicationText !== undefined
          ? { dedicationText: patch.dedicationText }
          : {}),
        ...(patch.backCoverBlurb !== undefined
          ? { backCoverBlurb: patch.backCoverBlurb }
          : {}),
        ...(patch.bookFormat !== undefined ? { bookFormat: patch.bookFormat } : {}),
        pages: updatedPages,
        updatedAt: new Date().toISOString(),
      };
    });

    if (missingPageNumber !== null) {
      return errorResponse({
        error: `Strona o numerze ${missingPageNumber} nie istnieje w tej bajce.`,
        code: 'PAGE_NOT_FOUND',
        status: 404,
        requestId,
      });
    }

    if (!updatedStory) {
      return errorResponse({
        error: 'Nie znaleziono bajki o podanym identyfikatorze.',
        code: 'NOT_FOUND',
        status: 404,
        requestId,
      });
    }

    return jsonResponse({ story: updatedStory }, { status: 200, requestId });
  } catch (err) {
    return handleApiError(err, requestId);
  }
}

export async function DELETE(
  request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  const requestId = getOrCreateRequestId(request);
  try {
    const { id } = await context.params;
    const safeId = assertValidStoryId(id);
    const deleted = await deleteStory(safeId);
    if (!deleted) {
      return errorResponse({
        error: 'Nie znaleziono bajki do usunięcia.',
        code: 'NOT_FOUND',
        status: 404,
        requestId,
      });
    }
    return jsonResponse({ deleted: true, id: safeId }, { status: 200, requestId });
  } catch (err) {
    return handleApiError(err, requestId);
  }
}
