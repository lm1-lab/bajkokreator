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
  normalizeVerificationToken,
  resolveAuthorizedOrderActor,
  transitionOrder,
  type OrderActor,
} from '@/lib/orders/lifecycle';
import { getOrderByIdOrNumber, getOrderRepository } from '@/lib/orders/repository';
import { constantTimeTokenEqual, requireOperatorAuth } from '@/lib/security/operator-guard';
import {
  ROUTE_RATE_LIMITS,
  enforceRateLimit,
  parseOptionalJsonBodyWithLimit,
} from '@/lib/security/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const ApproveBodySchema = z.object({
  actor: OrderActorSchema.optional(),
  verification: z.string().trim().min(3).max(160).optional(),
  reason: z.string().trim().max(400).optional(),
  expectedVersion: z.number().int().min(1).optional(),
});

function verifyCustomerOwnership(
  shippingAddress: { email: string; postalCode: string } | undefined,
  rawVerification: string,
): boolean {
  if (!shippingAddress) return false;
  const provided = normalizeVerificationToken(rawVerification);
  if (!provided) return false;
  const expectedEmail = normalizeVerificationToken(shippingAddress.email);
  const expectedPostal = normalizeVerificationToken(shippingAddress.postalCode);
  return (
    constantTimeTokenEqual(provided, expectedEmail) ||
    constantTimeTokenEqual(provided, expectedPostal)
  );
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  const requestId = getOrCreateRequestId(request);
  try {
    const rawBody = (await parseOptionalJsonBodyWithLimit(request, 32 * 1024)) ?? {};
    const body = ApproveBodySchema.parse(rawBody);

    let effectiveActor: OrderActor;
    let isCustomerSelfService = false;

    if (body.verification) {
      await enforceRateLimit(request, ROUTE_RATE_LIMITS.supportOrderStatus);
      isCustomerSelfService = true;
      effectiveActor = { kind: 'customer', id: 'customer-portal' };
    } else {
      const identity = await requireOperatorAuth(request, ['admin', 'agent']);
      effectiveActor = resolveAuthorizedOrderActor(identity, body.actor);
    }

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

    if (
      isCustomerSelfService &&
      !verifyCustomerOwnership(order.shippingAddress, body.verification!)
    ) {
      return errorResponse({
        error: 'Nie znaleziono zamówienia lub podane dane weryfikacyjne są nieprawidłowe.',
        code: 'NOT_FOUND',
        status: 404,
        requestId,
      });
    }

    const prevStatus = order.status;
    const transitioned = transitionOrder(order, 'approved_for_print', {
      actor: effectiveActor,
      reason: body.reason ?? 'Zatwierdzenie podglądu książki do druku',
      ...(body.expectedVersion !== undefined ? { expectedVersion: body.expectedVersion } : {}),
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

    // Never leak shippingAddress PII back to unauthenticated customer self-service callers
    if (isCustomerSelfService) {
      const { shippingAddress: _redactedShipping, ...piiSafeOrder } = saved;
      void _redactedShipping;
      return jsonResponse({ order: piiSafeOrder }, { status: 200, requestId });
    }

    return jsonResponse({ order: saved }, { status: 200, requestId });
  } catch (err) {
    return handleApiError(err, requestId);
  }
}
