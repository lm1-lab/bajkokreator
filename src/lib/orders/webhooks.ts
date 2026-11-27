import crypto from 'node:crypto';
import { z } from 'zod';
import { getDomainEventBus } from '@/lib/ops/event-bus';
import {
  OrderGuardrailError,
  transitionOrder,
  type OrderRecord,
  type OrderStatus,
} from './lifecycle';
import { getOrderRepository } from './repository';

// =============================================================================
// Vendor-Agnostic Webhook Verification & Replay-Safe Event Ingestion
// =============================================================================

export interface WebhookVerificationInput {
  rawBody: string;
  signatureHeader: string;
  timestampHeader?: string;
  now?: Date;
}

export interface WebhookVerificationResult {
  valid: boolean;
  reason?: string;
}

export interface WebhookVerifier {
  readonly providerId: string;
  verify(input: WebhookVerificationInput): WebhookVerificationResult;
}

export class HmacSha256WebhookVerifier implements WebhookVerifier {
  readonly providerId: string;
  private readonly secret: string;
  private readonly maxTimestampSkewSeconds: number;

  constructor(params: {
    providerId: string;
    secret: string;
    maxTimestampSkewSeconds?: number;
  }) {
    this.providerId = params.providerId;
    this.secret = params.secret;
    this.maxTimestampSkewSeconds = params.maxTimestampSkewSeconds ?? 300;
  }

  sign(rawBody: string, timestampSeconds?: number): string {
    const payload =
      timestampSeconds !== undefined ? `${timestampSeconds}.${rawBody}` : rawBody;
    return crypto.createHmac('sha256', this.secret).update(payload, 'utf8').digest('hex');
  }

  verify(input: WebhookVerificationInput): WebhookVerificationResult {
    if (!this.secret) {
      return { valid: false, reason: 'WEBHOOK_SECRET_NOT_CONFIGURED' };
    }
    const providedHex = input.signatureHeader.trim().replace(/^sha256=/i, '');
    if (!/^[a-f0-9]{64}$/i.test(providedHex)) {
      return { valid: false, reason: 'MALFORMED_SIGNATURE' };
    }

    let signedPayload = input.rawBody;
    if (input.timestampHeader !== undefined) {
      const ts = Number.parseInt(input.timestampHeader.trim(), 10);
      if (!Number.isFinite(ts) || ts <= 0) {
        return { valid: false, reason: 'INVALID_TIMESTAMP' };
      }
      const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
      if (Math.abs(nowSeconds - ts) > this.maxTimestampSkewSeconds) {
        return { valid: false, reason: 'TIMESTAMP_OUT_OF_TOLERANCE' };
      }
      signedPayload = `${ts}.${input.rawBody}`;
    }

    const expectedHex = crypto
      .createHmac('sha256', this.secret)
      .update(signedPayload, 'utf8')
      .digest('hex');

    const providedBuf = Buffer.from(providedHex.toLowerCase(), 'hex');
    const expectedBuf = Buffer.from(expectedHex.toLowerCase(), 'hex');
    if (
      providedBuf.length !== expectedBuf.length ||
      !crypto.timingSafeEqual(providedBuf, expectedBuf)
    ) {
      return { valid: false, reason: 'SIGNATURE_MISMATCH' };
    }

    return { valid: true };
  }
}

export const PaymentWebhookEventSchema = z.object({
  eventId: z.string().trim().min(1).max(160),
  providerId: z.string().trim().min(1).max(80),
  orderId: z.string().trim().min(1).max(80),
  type: z.enum(['payment.succeeded', 'payment.refunded']),
  paymentReference: z.string().trim().min(1).max(160),
  occurredAt: z.iso.datetime({ offset: true }),
});
export type PaymentWebhookEvent = z.infer<typeof PaymentWebhookEventSchema>;

export const PrinterWebhookEventSchema = z.object({
  eventId: z.string().trim().min(1).max(160),
  providerId: z.string().trim().min(1).max(80),
  orderId: z.string().trim().min(1).max(80),
  type: z.enum(['print.in_production', 'print.shipped', 'print.delivered']),
  externalOrderId: z.string().trim().min(1).max(160).optional(),
  trackingNumber: z.string().trim().min(1).max(160).optional(),
  trackingUrl: z.url().optional(),
  occurredAt: z.iso.datetime({ offset: true }),
});
export type PrinterWebhookEvent = z.infer<typeof PrinterWebhookEventSchema>;

export interface WebhookIngestionResult {
  order: OrderRecord;
  duplicate: boolean;
}

export async function ingestPaymentWebhookEvent(
  rawEvent: PaymentWebhookEvent,
): Promise<WebhookIngestionResult> {
  const event = PaymentWebhookEventSchema.parse(rawEvent);
  const repo = getOrderRepository();
  const order = await repo.getOrder(event.orderId);
  if (!order) {
    throw new OrderGuardrailError(
      `Nie znaleziono zamówienia ${event.orderId} dla zdarzenia płatności.`,
      'INVALID_TRANSITION',
      409,
    );
  }

  if (order.processedEventIds.includes(event.eventId)) {
    return { order, duplicate: true };
  }

  const nextStatus: OrderStatus =
    event.type === 'payment.succeeded' ? 'paid' : 'refunded';
  const prevStatus = order.status;
  const transitioned = transitionOrder(order, nextStatus, {
    actor: { kind: 'payment-webhook', id: event.providerId },
    reason: `Webhook płatności: ${event.type} (${event.eventId})`,
    expectedVersion: order.version,
    patch: { paymentReference: event.paymentReference },
  });

  const saved = await repo.saveOrder(
    {
      ...transitioned,
      processedEventIds: [...order.processedEventIds, event.eventId],
    },
    order.version,
  );

  await getDomainEventBus().publish({
    type: 'order.status_changed',
    occurredAt: saved.updatedAt,
    orderId: saved.id,
    storyId: saved.storyId,
    from: prevStatus,
    to: saved.status,
    order: saved,
  });

  return { order: saved, duplicate: false };
}

export async function ingestPrinterWebhookEvent(
  rawEvent: PrinterWebhookEvent,
): Promise<WebhookIngestionResult> {
  const event = PrinterWebhookEventSchema.parse(rawEvent);
  const repo = getOrderRepository();
  const order = await repo.getOrder(event.orderId);
  if (!order) {
    throw new OrderGuardrailError(
      `Nie znaleziono zamówienia ${event.orderId} dla zdarzenia drukarni.`,
      'INVALID_TRANSITION',
      409,
    );
  }

  if (order.processedEventIds.includes(event.eventId)) {
    return { order, duplicate: true };
  }

  const statusMap: Record<PrinterWebhookEvent['type'], OrderStatus> = {
    'print.in_production': 'in_production',
    'print.shipped': 'shipped',
    'print.delivered': 'delivered',
  };
  const nextStatus = statusMap[event.type];
  const prevStatus = order.status;

  const transitioned = transitionOrder(order, nextStatus, {
    actor: { kind: 'printer-webhook', id: event.providerId },
    reason: `Webhook drukarni: ${event.type} (${event.eventId})`,
    expectedVersion: order.version,
    patch: {
      printProviderId: event.providerId,
      ...(event.externalOrderId ? { printExternalOrderId: event.externalOrderId } : {}),
      ...(event.trackingNumber ? { trackingNumber: event.trackingNumber } : {}),
      ...(event.trackingUrl ? { trackingUrl: event.trackingUrl } : {}),
    },
  });

  const saved = await repo.saveOrder(
    {
      ...transitioned,
      processedEventIds: [...order.processedEventIds, event.eventId],
    },
    order.version,
  );

  await getDomainEventBus().publish({
    type: 'order.status_changed',
    occurredAt: saved.updatedAt,
    orderId: saved.id,
    storyId: saved.storyId,
    from: prevStatus,
    to: saved.status,
    order: saved,
  });

  return { order: saved, duplicate: false };
}
