import type { PreflightReport } from '@/lib/preflight/checker';
import type { BookFormat } from '@/lib/types/story';
import type { OrderRecord, OrderStatus, ShippingAddress } from './lifecycle';

// =============================================================================
// Vendor-Agnostic Integration Ports (Print Fulfillment, Payments, Domain Events)
// Zero vendor lock-in: Gelato / Lulu / Polish print shops, Stripe / Przelewy24,
// and Inngest / Trigger.dev / BullMQ can implement these contracts later.
// =============================================================================

export interface PrintQuoteRequest {
  bookFormat: BookFormat;
  pageCount: number;
  quantity: number;
  countryCode: string;
}

export interface PrintQuoteResult {
  providerId: string;
  currency: string;
  unitCostMinorUnits: number;
  shippingCostMinorUnits: number;
  estimatedProductionDays: number;
  estimatedDeliveryDays: number;
}

export interface PrintSubmissionRequest {
  orderId: string;
  storyId: string;
  bookFormat: BookFormat;
  quantity: number;
  pdfUrlOrKey: string;
  shippingAddress: ShippingAddress;
  idempotencyKey: string;
}

export interface PrintSubmissionResult {
  providerId: string;
  externalOrderId: string;
  acceptedAt: string;
}

export interface PrintJobStatusResult {
  providerId: string;
  externalOrderId: string;
  status: 'queued' | 'in_production' | 'shipped' | 'delivered' | 'cancelled' | 'error';
  trackingNumber?: string;
  trackingUrl?: string;
  updatedAt: string;
}

export interface PrintFulfillmentAdapter {
  readonly providerId: string;
  quote(request: PrintQuoteRequest): Promise<PrintQuoteResult>;
  submitPrintJob(request: PrintSubmissionRequest): Promise<PrintSubmissionResult>;
  getPrintJobStatus(externalOrderId: string): Promise<PrintJobStatusResult>;
  cancelPrintJob(externalOrderId: string): Promise<{ cancelled: boolean }>;
}

export interface CheckoutSessionRequest {
  orderId: string;
  amountMinorUnits: number;
  currency: string;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
  description: string;
}

export interface CheckoutSessionResult {
  providerId: string;
  sessionId: string;
  checkoutUrl: string;
}

export interface PaymentAdapter {
  readonly providerId: string;
  createCheckoutSession(request: CheckoutSessionRequest): Promise<CheckoutSessionResult>;
  refundPayment(params: {
    paymentReference: string;
    amountMinorUnits: number;
    reason?: string;
  }): Promise<{ refundId: string; status: 'succeeded' | 'pending' }>;
}

// =============================================================================
// Domain Events (Ready for background queues & autonomous agent subscribers)
// =============================================================================

export type DomainEvent =
  | {
      type: 'story.created';
      occurredAt: string;
      storyId: string;
      provider: string;
      pageCount: number;
    }
  | {
      type: 'story.preflight_completed';
      occurredAt: string;
      storyId: string;
      report: PreflightReport;
    }
  | {
      type: 'story.reference_photos_purged';
      occurredAt: string;
      storyId: string;
      deletedCount: number;
    }
  | {
      type: 'order.status_changed';
      occurredAt: string;
      orderId: string;
      storyId: string;
      from: OrderStatus;
      to: OrderStatus;
      order: OrderRecord;
    };

export type DomainEventHandler = (event: DomainEvent) => Promise<void> | void;

export interface DomainEventBus {
  publish(event: DomainEvent): Promise<void>;
  subscribe(handler: DomainEventHandler): () => void;
}
