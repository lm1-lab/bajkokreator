import { NextResponse } from 'next/server';
import {
  buildSettingsSnapshot,
  getOrCreateRequestId,
  handleApiError,
  jsonResponse,
} from '@/lib/api-helpers';
import { requireOperatorAuth } from '@/lib/security/operator-guard';
import {
  ROUTE_RATE_LIMITS,
  enforceRateLimit,
  parseJsonBodyWithLimit,
} from '@/lib/security/rate-limit';
import { saveRuntimeSettings } from '@/lib/storage/store';
import { PatchSettingsSchema } from '@/lib/types/story';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request?: Request): Promise<NextResponse> {
  const requestId = getOrCreateRequestId(request);
  try {
    const snapshot = await buildSettingsSnapshot();
    return jsonResponse(snapshot, { status: 200, requestId });
  } catch (err) {
    return handleApiError(err, requestId);
  }
}

export async function PATCH(request: Request): Promise<NextResponse> {
  const requestId = getOrCreateRequestId(request);
  try {
    await requireOperatorAuth(request, ['admin']);
    await enforceRateLimit(request, ROUTE_RATE_LIMITS.settingsPatch);

    const rawBody = await parseJsonBodyWithLimit(request, 64 * 1024);
    const parsed = PatchSettingsSchema.parse(rawBody);
    await saveRuntimeSettings(parsed);
    const snapshot = await buildSettingsSnapshot();
    return jsonResponse(snapshot, { status: 200, requestId });
  } catch (err) {
    return handleApiError(err, requestId);
  }
}
