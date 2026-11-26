import { NextResponse } from 'next/server';
import { handleApiError, validateUploadedImageFile } from '@/lib/api-helpers';
import { assertValidStoryId } from '@/lib/storage/security';
import { getStory, saveStory, saveStoryAsset } from '@/lib/storage/store';
import { IllustrationSlotSchema } from '@/lib/types/story';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string; slot: string }>;
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    const { id, slot: rawSlot } = await context.params;
    const safeId = assertValidStoryId(id);

    const parsedSlot = IllustrationSlotSchema.safeParse(rawSlot);
    if (!parsedSlot.success) {
      return NextResponse.json(
        {
          error: 'Nieprawidłowy slot ilustracji (oczekiwano "cover" lub numer strony 1–12).',
          code: 'INVALID_SLOT',
        },
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

    const slot = parsedSlot.data;
    let targetPageIndex = -1;
    if (slot !== 'cover') {
      const pageNum = Number.parseInt(slot, 10);
      targetPageIndex = story.pages.findIndex((p) => p.pageNumber === pageNum);
      if (targetPageIndex === -1) {
        return NextResponse.json(
          {
            error: `Strona ${pageNum} nie istnieje w tej bajce.`,
            code: 'PAGE_NOT_FOUND',
          },
          { status: 404 },
        );
      }
    }

    const formData = await request.formData();
    const fileEntry = formData.get('file');
    if (!(fileEntry instanceof File)) {
      return NextResponse.json(
        { error: 'Brak pliku ilustracji w polu "file".', code: 'MISSING_FILE' },
        { status: 400 },
      );
    }

    const validated = await validateUploadedImageFile(fileEntry);
    const stamp = Date.now().toString(36);
    const filename =
      slot === 'cover'
        ? `cover-custom-${stamp}.${validated.ext}`
        : `page-${slot}-custom-${stamp}.${validated.ext}`;

    await saveStoryAsset(safeId, filename, validated.buffer);

    const now = new Date().toISOString();
    let updatedStory = { ...story, updatedAt: now };

    if (slot === 'cover') {
      updatedStory = {
        ...updatedStory,
        coverFilename: filename,
        coverStatus: 'custom-uploaded',
        coverUpdatedAt: now,
      };
    } else {
      const updatedPages = [...story.pages];
      updatedPages[targetPageIndex] = {
        ...updatedPages[targetPageIndex],
        imageFilename: filename,
        imageStatus: 'custom-uploaded',
        imageUpdatedAt: now,
      };
      updatedStory = {
        ...updatedStory,
        pages: updatedPages,
      };
    }

    await saveStory(updatedStory);

    const assetUrl = `/api/stories/${safeId}/assets/${filename}`;
    return NextResponse.json(
      {
        slot,
        filename,
        assetUrl,
        updatedAt: now,
      },
      { status: 200 },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
