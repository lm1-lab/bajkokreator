import { NextResponse } from 'next/server';
import {
  errorResponse,
  getOrCreateRequestId,
  handleApiError,
  jsonResponse,
} from '@/lib/api-helpers';
import { executeOrderPreflight } from '@/lib/orders/fulfillment';
import { getOrderByIdOrNumber } from '@/lib/orders/repository';
import { requireOperatorAuth } from '@/lib/security/operator-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  const requestId = getOrCreateRequestId(request);
  try {
    const identity = await requireOperatorAuth(request, ['admin', 'agent']);
    const { id } = await context.params;
    const existing = await getOrderByIdOrNumber(id);
    if (!existing) {
      return errorResponse({
        error: 'Nie znaleziono zamówienia o podanym identyfikatorze.',
        code: 'NOT_FOUND',
        status: 404,
        requestId,
      });
    }

    const result = await executeOrderPreflight({
      orderId: existing.id,
      actor: {
        kind: identity.role === 'agent' ? 'agent' : 'system',
        id: identity.id,
      },
    });
    if (!result) {
      return errorResponse({
        error: 'Nie znaleziono zamówienia o podanym identyfikatorze.',
        code: 'NOT_FOUND',
        status: 404,
        requestId,
      });
    }

    return jsonResponse(
      { order: result.order, preflight: result.preflight },
      { status: 200, requestId },
    );
  } catch (err) {
    return handleApiError(err, requestId);
  }
}
