import { NextResponse } from 'next/server';
import {
  errorResponse,
  getOrCreateRequestId,
  handleApiError,
  jsonResponse,
} from '@/lib/api-helpers';
import { buildOpsSummary } from '@/lib/ops/summary';
import { requireOperatorAuth } from '@/lib/security/operator-guard';
import { ROUTE_RATE_LIMITS, enforceRateLimit } from '@/lib/security/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const requestId = getOrCreateRequestId(request);
  try {
    await requireOperatorAuth(request, ['ops-readonly', 'admin', 'agent']);
    await enforceRateLimit(request, ROUTE_RATE_LIMITS.opsSummary);

    const url = new URL(request.url);
    const rawUpcomingDays = url.searchParams.get('upcomingDays');
    let upcomingDays: number | undefined;
    if (rawUpcomingDays !== null) {
      const trimmed = rawUpcomingDays.trim();
      if (!/^\d+$/.test(trimmed)) {
        return errorResponse({
          error: 'Parametr upcomingDays musi być dodatnią liczbą całkowitą w zakresie 1–365.',
          code: 'INVALID_UPCOMING_DAYS',
          status: 400,
          requestId,
        });
      }
      const parsed = Number.parseInt(trimmed, 10);
      if (parsed < 1 || parsed > 365) {
        return errorResponse({
          error: 'Parametr upcomingDays musi mieścić się w zakresie 1–365.',
          code: 'INVALID_UPCOMING_DAYS',
          status: 400,
          requestId,
        });
      }
      upcomingDays = parsed;
    }

    const summary = await buildOpsSummary({ upcomingDays });
    return jsonResponse(
      {
        summary,
        requestId,
      },
      { status: 200, requestId },
    );
  } catch (err) {
    return handleApiError(err, requestId);
  }
}
