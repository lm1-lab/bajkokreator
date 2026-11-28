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
  OrderStatusSchema,
  ShippingAddressSchema,
  resolveAuthorizedOrderActor,
  transitionOrder,
} from '@/lib/orders/lifecycle';
import { getOrderByIdOrNumber, getOrderRepository } from '@/lib/orders/repository';
import { requireOperatorAuth } from '@/lib/security/operator-guard';
import { parseJsonBodyWithLimit } from '@/lib/security/rate-limit';
import { getStory } from '@/lib/storage/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const TransitionPatchSchema = z
  .object({
    paymentReference: z.string().trim().min(1).max(160).optional(),
    preflightPassed: z.boolean().optional(),
    preflightScore: z.number().int().min(0).max(100).optional(),
    preflightStoryUpdatedAt: z.iso.datetime({ offset: true }).optional(),
    printManifestDigest: z.string().trim().min(16).max(128).optional(),
    printProviderId: z.string().trim().min(1).max(80).optional(),
    printExternalOrderId: z.string().trim().min(1).max(160).optional(),
    trackingNumber: z.string().trim().min(1).max(160).optional(),
    trackingUrl: z.url().optional(),
    shippingAddress: ShippingAddressSchema.optional(),
  })
  .optional();

const TransitionBodySchema = z
  .object({
    nextStatus: OrderStatusSchema.optional(),
    to: OrderStatusSchema.optional(),
    actor: OrderActorSchema.optional(),
    expectedVersion: z.number().int().min(1).optional(),
    reason: z.string().trim().max(400).optional(),
    patch: TransitionPatchSchema,
  })
  .refine((val) => val.nextStatus !== undefined || val.to !== undefined, {
    message: 'Podaj docelowy status zamówienia (nextStatus lub to).',
  });

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

    const rawBody = await parseJsonBodyWithLimit(request, 64 * 1024);
    const body = TransitionBodySchema.parse(rawBody);
    const targetStatus = (body.nextStatus ?? body.to)!;
    const effectiveActor = resolveAuthorizedOrderActor(identity, body.actor);

    let currentStoryUpdatedAt: string | undefined;
    if (targetStatus === 'submitted_to_printer') {
      const story = await getStory(order.storyId);
      currentStoryUpdatedAt = story?.updatedAt;
    }

    const prevStatus = order.status;
    const transitioned = transitionOrder(order, targetStatus, {
      actor: effectiveActor,
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
      ...(body.expectedVersion !== undefined ? { expectedVersion: body.expectedVersion } : {}),
      ...(currentStoryUpdatedAt ? { currentStoryUpdatedAt } : {}),
      ...(body.patch ? { patch: body.patch } : {}),
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
