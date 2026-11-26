import { NextResponse } from 'next/server';
import { handleApiError } from '@/lib/api-helpers';
import { assertValidStoryId } from '@/lib/storage/security';
import { deleteStory, getStory, saveStory } from '@/lib/storage/store';
import { PatchStorySchema } from '@/lib/types/story';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    const { id } = await context.params;
    const safeId = assertValidStoryId(id);
    const story = await getStory(safeId);
    if (!story) {
      return NextResponse.json(
        { error: 'Nie znaleziono bajki o podanym identyfikatorze.', code: 'NOT_FOUND' },
        { status: 404 },
      );
    }
    return NextResponse.json(
      { story },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PATCH(
  request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    const { id } = await context.params;
    const safeId = assertValidStoryId(id);
    const story = await getStory(safeId);
    if (!story) {
      return NextResponse.json(
        { error: 'Nie znaleziono bajki o podanym identyfikatorze.', code: 'NOT_FOUND' },
        { status: 404 },
      );
    }

    const rawBody: unknown = await request.json();
    const patch = PatchStorySchema.parse(rawBody);
    const now = new Date().toISOString();

    const updatedPages = [...story.pages];
    const pageUpdates = [
      ...(patch.page ? [patch.page] : []),
      ...(patch.pages ?? []),
    ];

    for (const item of pageUpdates) {
      const idx = updatedPages.findIndex((p) => p.pageNumber === item.pageNumber);
      if (idx === -1) {
        return NextResponse.json(
          {
            error: `Strona o numerze ${item.pageNumber} nie istnieje w tej bajce.`,
            code: 'PAGE_NOT_FOUND',
          },
          { status: 404 },
        );
      }
      updatedPages[idx] = {
        ...updatedPages[idx],
        text: item.text,
        ...(item.chapterTitle !== undefined ? { chapterTitle: item.chapterTitle } : {}),
      };
    }

    const updatedStory = {
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
      updatedAt: now,
    };

    await saveStory(updatedStory);
    return NextResponse.json({ story: updatedStory }, { status: 200 });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(
  _request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    const { id } = await context.params;
    const safeId = assertValidStoryId(id);
    const deleted = await deleteStory(safeId);
    if (!deleted) {
      return NextResponse.json(
        { error: 'Nie znaleziono bajki do usunięcia.', code: 'NOT_FOUND' },
        { status: 404 },
      );
    }
    return NextResponse.json({ deleted: true, id: safeId }, { status: 200 });
  } catch (err) {
    return handleApiError(err);
  }
}
