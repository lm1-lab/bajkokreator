import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  errorResponse,
  getOrCreateRequestId,
  handleApiError,
  jsonResponse,
} from '@/lib/api-helpers';
import { getDomainEventBus } from '@/lib/ops/event-bus';
import {
  OrderActorSchema,
  resolveAuthorizedOrderActor,
  transitionOrder,
} from '@/lib/orders/lifecycle';
import { getOrderByIdOrNumber, getOrderRepository } from '@/lib/orders/repository';
import { requireOperatorAuth } from '@/lib/security/operator-guard';
import { parseOptionalJsonBodyWithLimit } from '@/lib/security/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const RefundBodySchema = z.object({
  actor: OrderActorSchema.optional(),
  reason: z.string().trim().max(400).optional(),
  expectedVersion: z.number().int().min(1).optional(),
});

function getConfiguredMaxAgentAutoRefund(): number {
  const raw = process.env.BAJKOKREATOR_MAX_AGENT_AUTO_REFUND_GROSZE?.trim();
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  const requestId = getOrCreateRequestId(request);
  try {
    const identity = await requireOperatorAuth(request, ['admin', 'agent']);
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

    const rawBody = (await parseOptionalJsonBodyWithLimit(request, 32 * 1024)) ?? {};
    const body = RefundBodySchema.parse(rawBody);
    const effectiveActor = resolveAuthorizedOrderActor(identity, body.actor);

    const prevStatus = order.status;
    const transitioned = transitionOrder(order, 'refunded', {
      actor: effectiveActor,
      reason: body.reason ?? 'Zwrot środków za zamówienie',
      ...(body.expectedVersion !== undefined ? { expectedVersion: body.expectedVersion } : {}),
      policy: {
        maxAgentAutoRefundMinorUnits: getConfiguredMaxAgentAutoRefund(),
      },
    });

    const saved = await getOrderRepository().saveOrder(transitioned, order.version);

    await getDomainEventBus().publish({
      type: 'order.status_changed',
      occurredAt: saved.updatedAt,
      orderId: saved.id,
      storyId: saved.storyId,
      from: prevStatus,
      to: saved.status,
      order: saved,
    });

    return jsonResponse({ order: saved }, { status: 200, requestId });
  } catch (err) {
    return handleApiError(err, requestId);
  }
}
