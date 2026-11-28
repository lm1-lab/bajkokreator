import { NextResponse } from 'next/server';
import {
  errorResponse,
  getOrCreateRequestId,
  handleApiError,
  jsonResponse,
} from '@/lib/api-helpers';
import { buildPrintJobManifest } from '@/lib/orders/fulfillment';
import { getOrderByIdOrNumber } from '@/lib/orders/repository';
import { PdfLayoutModeSchema } from '@/lib/pdf/layout-spec';
import { requireOperatorAuth } from '@/lib/security/operator-guard';
import { getStory } from '@/lib/storage/store';

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
    await requireOperatorAuth(request, ['admin', 'agent', 'ops-readonly']);
    const { id } = await context.params;
    const order = await getOrderByIdOrNumber(id);
    if (!order) {
      return errorResponse({
        error: 'Nie znaleziono zamówienia o podanym identyfikatorze.',
        code: 'NOT_FOUND',
        status: 404,
        requestId,
      });
    }

    const story = await getStory(order.storyId);
    if (!story) {
      return errorResponse({
        error: 'Nie znaleziono bajki powiązanej z zamówieniem.',
        code: 'STORY_NOT_FOUND',
        status: 404,
        requestId,
      });
    }

    const url = new URL(request.url);
    const rawLayoutMode = url.searchParams.get('layoutMode');
    const layoutMode = rawLayoutMode ? PdfLayoutModeSchema.parse(rawLayoutMode) : 'combined';

    const { manifest, digest } = await buildPrintJobManifest(order, story, {
      layoutMode,
    });

    return jsonResponse({ manifest, digest }, { status: 200, requestId });
  } catch (err) {
    return handleApiError(err, requestId);
  }
}
