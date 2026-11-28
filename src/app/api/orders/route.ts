import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  errorResponse,
  getOrCreateRequestId,
  handleApiError,
  jsonResponse,
} from '@/lib/api-helpers';
import {
  computePayloadDigest,
  getIdempotencyStore,
  withIdempotencyLock,
} from '@/lib/orders/idempotency';
import {
  OrderGuardrailError,
  OrderStatusSchema,
  ShippingAddressSchema,
  calculateOrderTotalMinorUnits,
  createOrderDraft,
} from '@/lib/orders/lifecycle';
import { getOrderRepository } from '@/lib/orders/repository';
import { requireOperatorAuth } from '@/lib/security/operator-guard';
import {
  ROUTE_RATE_LIMITS,
  enforceRateLimit,
  parseJsonBodyWithLimit,
} from '@/lib/security/rate-limit';
import { getStory } from '@/lib/storage/store';
import { BookFormatSchema, StoryIdSchema } from '@/lib/types/story';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CreateOrderBodySchema = z.object({
  storyId: StoryIdSchema,
  bookFormat: BookFormatSchema.optional(),
  quantity: z.number().int().min(1).max(100).default(1),
  currency: z.string().trim().length(3).toUpperCase().default('PLN'),
  /** Accepted for backwards compatibility, but always computed authoritatively server-side. */
  totalMinorUnits: z.number().int().min(0).optional(),
  shippingAddress: ShippingAddressSchema.optional(),
  idempotencyKey: z.string().trim().min(1).max(160).optional(),
});

export async function GET(request: Request): Promise<NextResponse> {
  const requestId = getOrCreateRequestId(request);
  try {
    await requireOperatorAuth(request, ['admin', 'agent', 'ops-readonly']);

    const url = new URL(request.url);
    const rawStoryId = url.searchParams.get('storyId')?.trim();
    const rawStatus = url.searchParams.get('status')?.trim();

    let storyId: string | undefined;
    if (rawStoryId) {
      storyId = StoryIdSchema.parse(rawStoryId);
    }

    let status: z.infer<typeof OrderStatusSchema> | undefined;
    if (rawStatus) {
      status = OrderStatusSchema.parse(rawStatus);
    }

    const orders = await getOrderRepository().listOrders({
      ...(storyId ? { storyId } : {}),
      ...(status ? { status } : {}),
    });

    return jsonResponse({ orders }, { status: 200, requestId });
  } catch (err) {
    return handleApiError(err, requestId);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const requestId = getOrCreateRequestId(request);
  try {
    await enforceRateLimit(request, ROUTE_RATE_LIMITS.ordersCreate);
    const rawBody = await parseJsonBodyWithLimit(request, 64 * 1024);
    const parsed = CreateOrderBodySchema.parse(rawBody);

    const headerKey = request.headers.get('idempotency-key')?.trim();
    const idempotencyKey = headerKey || parsed.idempotencyKey;

    const executeCreate = async (): Promise<NextResponse> => {
      const repo = getOrderRepository();
      const idemStore = getIdempotencyStore();

      const story = await getStory(parsed.storyId);
      if (!story) {
        return errorResponse({
          error: 'Nie znaleziono bajki powiązanej z zamówieniem.',
          code: 'STORY_NOT_FOUND',
          status: 404,
          requestId,
        });
      }

      const resolvedBookFormat = parsed.bookFormat ?? story.bookFormat;
      const authoritativeTotalMinorUnits = calculateOrderTotalMinorUnits(
        resolvedBookFormat,
        parsed.quantity,
      );

      const payloadDigest = computePayloadDigest({
        storyId: story.id,
        bookFormat: resolvedBookFormat,
        quantity: parsed.quantity,
        currency: 'PLN',
        totalMinorUnits: authoritativeTotalMinorUnits,
        shippingAddress: parsed.shippingAddress ?? null,
      });

      if (idempotencyKey) {
        const existingRecord = await idemStore.get('orders:create', idempotencyKey);
        if (existingRecord) {
          if (existingRecord.payloadDigest !== payloadDigest) {
            throw new OrderGuardrailError(
              'Klucz Idempotency-Key został już użyty z innymi parametrami zamówienia.',
              'IDEMPOTENCY_CONFLICT',
              409,
            );
          }
          const existingOrder = await repo.getOrder(existingRecord.resourceId);
          if (existingOrder) {
            return jsonResponse({ order: existingOrder }, { status: 200, requestId });
          }
        }

        const byKey = await repo.findByIdempotencyKey(idempotencyKey);
        if (byKey) {
          const existingDigest = computePayloadDigest({
            storyId: byKey.storyId,
            bookFormat: byKey.bookFormat,
            quantity: byKey.quantity,
            currency: byKey.currency,
            totalMinorUnits: byKey.totalMinorUnits,
            shippingAddress: byKey.shippingAddress ?? null,
          });
          if (existingDigest !== payloadDigest) {
            throw new OrderGuardrailError(
              'Klucz Idempotency-Key został już użyty z innymi parametrami zamówienia.',
              'IDEMPOTENCY_CONFLICT',
              409,
            );
          }
          return jsonResponse({ order: byKey }, { status: 200, requestId });
        }
      }

      const draft = createOrderDraft({
        storyId: story.id,
        bookFormat: resolvedBookFormat,
        quantity: parsed.quantity,
        currency: 'PLN',
        totalMinorUnits: authoritativeTotalMinorUnits,
        ...(parsed.shippingAddress ? { shippingAddress: parsed.shippingAddress } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });

      const saved = await repo.createOrder(draft);

      if (idempotencyKey) {
        await idemStore.save({
          key: idempotencyKey,
          scope: 'orders:create',
          payloadDigest,
          resourceId: saved.id,
          statusCode: 201,
          createdAt: saved.createdAt,
        });
      }

      return jsonResponse({ order: saved }, { status: 201, requestId });
    };

    if (idempotencyKey) {
      return await withIdempotencyLock('orders:create', idempotencyKey, executeCreate);
    }
    return await executeCreate();
  } catch (err) {
    return handleApiError(err, requestId);
  }
}
