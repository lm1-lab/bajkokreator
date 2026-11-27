import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  errorResponse,
  getOrCreateRequestId,
  handleApiError,
  jsonResponse,
} from '@/lib/api-helpers';
import { getDomainEventBus } from '@/lib/ops/event-bus';
import { OrderActorSchema, transitionOrder } from '@/lib/orders/lifecycle';
import { getOrderByIdOrNumber, getOrderRepository } from '@/lib/orders/repository';
import { requireOperatorAuth } from '@/lib/security/operator-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const RefundBodySchema = z.object({
  actor: OrderActorSchema.default({ kind: 'admin', id: 'operator' }),
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
    await requireOperatorAuth(request, ['admin', 'agent']);
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

    let rawBody: unknown = {};
    const text = await request.text();
    if (text.trim().length > 0) {
      rawBody = JSON.parse(text);
    }
    const body = RefundBodySchema.parse(rawBody);

    const prevStatus = order.status;
    const transitioned = transitionOrder(order, 'refunded', {
      actor: body.actor,
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
