import { NextResponse } from 'next/server';
import {
  errorResponse,
  getOrCreateRequestId,
  handleApiError,
} from '@/lib/api-helpers';
import { generateStoryPdf } from '@/lib/pdf/generator';
import {
  MAX_BLEED_MM,
  MAX_SPINE_MM,
  MIN_BLEED_MM,
  MIN_SPINE_MM,
  PdfLayoutModeSchema,
} from '@/lib/pdf/layout-spec';
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
  const requestId = getOrCreateRequestId(request);
  try {
    const { id } = await context.params;
    const safeId = assertValidStoryId(id);

    const url = new URL(request.url);
    const rawFormat = url.searchParams.get('format');

    const story = await getStory(safeId);
    if (!story) {
      return errorResponse({
        error: 'Nie znaleziono bajki do wyeksportowania.',
        code: 'NOT_FOUND',
        status: 404,
        requestId,
      });
    }

    const formatCandidate = rawFormat ?? story.bookFormat ?? 'square';
    const parsedFormat = BookFormatSchema.safeParse(formatCandidate);
    if (!parsedFormat.success) {
      return errorResponse({
        error: 'Nieprawidłowy format PDF. Dozwolone wartości: "square" lub "a4-landscape".',
        code: 'INVALID_PDF_FORMAT',
        status: 400,
        requestId,
      });
    }

    const rawBleedMm = url.searchParams.get('bleedMm');
    let bleedMm = 0;
    if (rawBleedMm !== null) {
      const trimmedBleed = rawBleedMm.trim();
      const parsedBleed = Number(trimmedBleed);
      if (
        trimmedBleed.length === 0 ||
        !Number.isFinite(parsedBleed) ||
        parsedBleed < MIN_BLEED_MM ||
        parsedBleed > MAX_BLEED_MM
      ) {
        return errorResponse({
          error: `Nieprawidłowy parametr bleedMm. Dozwolony zakres: ${MIN_BLEED_MM}–${MAX_BLEED_MM} mm.`,
          code: 'INVALID_BLEED',
          status: 400,
          requestId,
        });
      }
      bleedMm = parsedBleed;
    }

    const rawLayoutMode = url.searchParams.get('layoutMode');
    const parsedLayoutMode = PdfLayoutModeSchema.safeParse(rawLayoutMode ?? 'combined');
    if (!parsedLayoutMode.success) {
      return errorResponse({
        error:
          'Nieprawidłowy parametr layoutMode. Dozwolone wartości: "combined", "interior" lub "cover-wrap".',
        code: 'INVALID_LAYOUT_MODE',
        status: 400,
        requestId,
      });
    }
    const layoutMode = parsedLayoutMode.data;

    const rawSpineMm = url.searchParams.get('spineMm');
    let spineMm: number | undefined;
    if (rawSpineMm !== null) {
      const trimmedSpine = rawSpineMm.trim();
      const parsedSpine = Number(trimmedSpine);
      if (
        trimmedSpine.length === 0 ||
        !Number.isFinite(parsedSpine) ||
        parsedSpine < MIN_SPINE_MM ||
        parsedSpine > MAX_SPINE_MM
      ) {
        return errorResponse({
          error: `Nieprawidłowy parametr spineMm. Dozwolony zakres: ${MIN_SPINE_MM}–${MAX_SPINE_MM} mm.`,
          code: 'INVALID_SPINE',
          status: 400,
          requestId,
        });
      }
      spineMm = parsedSpine;
    }

    const cropMarks = url.searchParams.get('cropMarks') === 'true';
    const padToMultipleOf4 = url.searchParams.get('padToMultipleOf4') === 'true';

    const pdfBytes = await generateStoryPdf(story, parsedFormat.data, undefined, {
      bleedMm,
      cropMarks,
      padToMultipleOf4,
      layoutMode,
      spineMm,
    });
    const slug = sanitizeFileSlug(story.input.childName || story.title, 'bajka', 32);
    const modeSuffix = layoutMode === 'combined' ? '' : `-${layoutMode}`;
    const printSuffix = bleedMm > 0 ? `-print-${bleedMm}mm` : '';
    const filename = `bajka-${slug}-${parsedFormat.data}${modeSuffix}${printSuffix}.pdf`;

    return new NextResponse(new Uint8Array(pdfBytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(pdfBytes.byteLength),
        'X-PDF-Layout-Mode': layoutMode,
        'X-Request-Id': requestId,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store, max-age=0',
      },
    });
  } catch (err) {
    return handleApiError(err, requestId);
  }
}
