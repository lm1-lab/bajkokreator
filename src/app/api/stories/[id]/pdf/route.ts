import { NextResponse } from 'next/server';
import { handleApiError } from '@/lib/api-helpers';
import { generateStoryPdf } from '@/lib/pdf/generator';
import { assertValidStoryId, sanitizeFileSlug } from '@/lib/storage/security';
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
  try {
    const { id } = await context.params;
    const safeId = assertValidStoryId(id);

    const url = new URL(request.url);
    const rawFormat = url.searchParams.get('format');

    const story = await getStory(safeId);
    if (!story) {
      return NextResponse.json(
        { error: 'Nie znaleziono bajki do wyeksportowania.', code: 'NOT_FOUND' },
        { status: 404 },
      );
    }

    const formatCandidate = rawFormat ?? story.bookFormat ?? 'square';
    const parsedFormat = BookFormatSchema.safeParse(formatCandidate);
    if (!parsedFormat.success) {
      return NextResponse.json(
        {
          error: 'Nieprawidłowy format PDF. Dozwolone wartości: "square" lub "a4-landscape".',
          code: 'INVALID_PDF_FORMAT',
        },
        { status: 400 },
      );
    }

    const pdfBytes = await generateStoryPdf(story, parsedFormat.data);
    const slug = sanitizeFileSlug(story.input.childName || story.title, 'bajka', 32);
    const filename = `bajka-${slug}-${parsedFormat.data}.pdf`;

    return new NextResponse(new Uint8Array(pdfBytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(pdfBytes.byteLength),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store, max-age=0',
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
