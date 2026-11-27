import { NextResponse } from 'next/server';
import {
  errorResponse,
  getOrCreateRequestId,
  handleApiError,
  jsonResponse,
} from '@/lib/api-helpers';
import {
  OrderStatusLookupInputSchema,
  lookupCustomerOrderStatus,
} from '@/lib/support/order-lookup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const requestId = getOrCreateRequestId(request);
  try {
    const rawBody: unknown = await request.json();
    const input = OrderStatusLookupInputSchema.parse(rawBody);
    const statusView = await lookupCustomerOrderStatus(input);

    if (!statusView) {
      // Indistinguishable 404 for both missing order and wrong verification — zero PII leak
      return errorResponse({
        error:
          'Nie znaleziono zamówienia lub podane dane weryfikacyjne są nieprawidłowe.',
        code: 'ORDER_LOOKUP_NOT_FOUND',
        status: 404,
        requestId,
      });
    }

    return jsonResponse(
      {
        found: true,
        statusView,
      },
      { status: 200, requestId },
    );
  } catch (err) {
    return handleApiError(err, requestId);
  }
}
