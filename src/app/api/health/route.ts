import { NextResponse } from 'next/server';
import {
  getOrCreateRequestId,
  handleApiError,
  jsonResponse,
} from '@/lib/api-helpers';
import { checkSystemHealth } from '@/lib/ops/health';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request?: Request): Promise<NextResponse> {
  const requestId = getOrCreateRequestId(request);
  try {
    const report = await checkSystemHealth();
    const status = report.status === 'unhealthy' ? 503 : 200;
    return jsonResponse(
      {
        ...report,
        requestId,
      },
      { status, requestId },
    );
  } catch (err) {
    return handleApiError(err, requestId);
  }
}
