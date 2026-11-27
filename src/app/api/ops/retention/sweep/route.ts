import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getOrCreateRequestId,
  handleApiError,
  jsonResponse,
} from '@/lib/api-helpers';
import { runRetentionSweep } from '@/lib/ops/retention';
import { requireOperatorAuth } from '@/lib/security/operator-guard';
import {
  ROUTE_RATE_LIMITS,
  enforceRateLimit,
  parseOptionalJsonBodyWithLimit,
} from '@/lib/security/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RetentionSweepBodySchema = z.object({
  maxAgeHoursAfterCreation: z.number().finite().min(0).max(24 * 365 * 5).optional(),
  ttlHours: z.number().finite().min(0).max(24 * 365 * 5).optional(),
  ttlDays: z.number().finite().min(0).max(365 * 5).optional(),
  dryRun: z.boolean().optional(),
  protectIncompleteStories: z.boolean().optional(),
  now: z.iso.datetime({ offset: true }).optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  const requestId = getOrCreateRequestId(request);
  try {
    const identity = await requireOperatorAuth(request, ['admin', 'agent']);
    await enforceRateLimit(request, ROUTE_RATE_LIMITS.opsRetentionSweep);

    const rawBody = await parseOptionalJsonBodyWithLimit(request, 32 * 1024);
    const parsed = rawBody !== undefined ? RetentionSweepBodySchema.parse(rawBody) : {};

    const maxAgeHoursAfterCreation =
      parsed.maxAgeHoursAfterCreation ??
      parsed.ttlHours ??
      (parsed.ttlDays !== undefined ? parsed.ttlDays * 24 : undefined);

    const summary = await runRetentionSweep({
      ...(maxAgeHoursAfterCreation !== undefined ? { maxAgeHoursAfterCreation } : {}),
      ...(parsed.dryRun !== undefined ? { dryRun: parsed.dryRun } : {}),
      ...(parsed.protectIncompleteStories !== undefined
        ? { protectIncompleteStories: parsed.protectIncompleteStories }
        : {}),
      ...(parsed.now !== undefined ? { now: new Date(parsed.now) } : {}),
    });

    return jsonResponse(
      {
        ...summary,
        summary,
        operator: {
          id: identity.id,
          role: identity.role,
        },
        requestId,
      },
      { status: 200, requestId },
    );
  } catch (err) {
    return handleApiError(err, requestId);
  }
}
