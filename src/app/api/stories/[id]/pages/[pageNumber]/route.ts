import { NextResponse } from 'next/server';
import { handleApiError } from '@/lib/api-helpers';
import { assertValidStoryId } from '@/lib/storage/security';
import { getStory, saveStory } from '@/lib/storage/store';
import { PageNumberSchema, PatchPageSchema } from '@/lib/types/story';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string; pageNumber: string }>;
}

export async function PATCH(
  request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    const { id, pageNumber: rawPageNumber } = await context.params;
    const safeId = assertValidStoryId(id);

    if (!/^\d+$/.test(rawPageNumber)) {
      return NextResponse.json(
        { error: 'Nieprawidłowy numer strony.', code: 'INVALID_PAGE_NUMBER' },
        { status: 400 },
      );
    }

    const parsedPageNum = PageNumberSchema.safeParse(Number.parseInt(rawPageNumber, 10));
    if (!parsedPageNum.success) {
      return NextResponse.json(
        { error: 'Numer strony poza dozwolonym zakresem.', code: 'INVALID_PAGE_NUMBER' },
        { status: 400 },
      );
    }

    const story = await getStory(safeId);
    if (!story) {
      return NextResponse.json(
        { error: 'Nie znaleziono bajki o podanym identyfikatorze.', code: 'NOT_FOUND' },
        { status: 404 },
      );
    }

    const pageIndex = story.pages.findIndex((p) => p.pageNumber === parsedPageNum.data);
    if (pageIndex === -1) {
      return NextResponse.json(
        {
          error: `Strona ${parsedPageNum.data} nie istnieje w tej bajce.`,
          code: 'PAGE_NOT_FOUND',
        },
        { status: 404 },
      );
    }

    const rawBody: unknown = await request.json();
    const patch = PatchPageSchema.parse(rawBody);
    const now = new Date().toISOString();

    const updatedPage = {
      ...story.pages[pageIndex],
      text: patch.text,
      ...(patch.chapterTitle !== undefined ? { chapterTitle: patch.chapterTitle } : {}),
    };

    const updatedPages = [...story.pages];
    updatedPages[pageIndex] = updatedPage;

    await saveStory({
      ...story,
      pages: updatedPages,
      updatedAt: now,
    });

    return NextResponse.json(
      {
        page: updatedPage,
        updatedAt: now,
      },
      { status: 200 },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
