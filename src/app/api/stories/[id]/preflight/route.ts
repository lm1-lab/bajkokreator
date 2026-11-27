import { NextResponse } from 'next/server';
import {
  errorResponse,
  getOrCreateRequestId,
  handleApiError,
  jsonResponse,
} from '@/lib/api-helpers';
import { runStoryPreflight } from '@/lib/preflight/checker';
import { assertValidStoryId } from '@/lib/storage/security';
import { getStory } from '@/lib/storage/store';
import { BookFormatSchema } from '@/lib/types/story';

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
        error: 'Nie znaleziono bajki do weryfikacji pre-flight.',
        code: 'NOT_FOUND',
        status: 404,
        requestId,
      });
    }

    const url = new URL(request.url);
    const rawFormat = url.searchParams.get('format');
    const formatCandidate = rawFormat ?? story.bookFormat ?? 'square';
    const parsedFormat = BookFormatSchema.safeParse(formatCandidate);

    if (!parsedFormat.success) {
      return errorResponse({
        error: 'Nieprawidłowy format książki. Dozwolone wartości: "square" lub "a4-landscape".',
        code: 'INVALID_BOOK_FORMAT',
        status: 400,
        requestId,
      });
    }

    const report = await runStoryPreflight(story, parsedFormat.data);
    return jsonResponse({ report }, { status: 200, requestId });
  } catch (err) {
    return handleApiError(err, requestId);
  }
}
