import crypto from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { z } from 'zod';
import { getDomainEventBus } from '@/lib/ops/event-bus';
import { generateStoryPdf, type PdfGenerationOptions } from '@/lib/pdf/generator';
import { PdfLayoutModeSchema, type PdfLayoutMode } from '@/lib/pdf/layout-spec';
import { runStoryPreflight, type PreflightReport } from '@/lib/preflight/checker';
import { getStory } from '@/lib/storage/store';
import { BookFormatSchema, StoryIdSchema, type StoryRecord } from '@/lib/types/story';
import {
  ORDER_ID_REGEX,
  ORDER_NUMBER_REGEX,
  OrderGuardrailError,
  ShippingAddressSchema,
  transitionOrder,
  type OrderActor,
  type OrderRecord,
} from './lifecycle';
import type {
  CheckoutSessionRequest,
  CheckoutSessionResult,
  PaymentAdapter,
  PrintFulfillmentAdapter,
  PrintJobStatusResult,
  PrintQuoteRequest,
  PrintQuoteResult,
  PrintSubmissionRequest,
  PrintSubmissionResult,
} from './ports';
import { getOrderRepository } from './repository';

// =============================================================================
// Preflight-Gated PrintJobManifest Builder, OrderFulfillmentService & Dry-Run Adapters
// =============================================================================

export const PrintJobManifestSchema = z.object({
  manifestVersion: z.literal(1),
  orderId: z.string().regex(ORDER_ID_REGEX),
  orderNumber: z.string().regex(ORDER_NUMBER_REGEX),
  storyId: StoryIdSchema,
  bookFormat: BookFormatSchema,
  quantity: z.number().int().min(1).max(100),
  pdfSpec: z.object({
    bleedMm: z.number().min(0).max(10),
    cropMarks: z.boolean(),
    padToMultipleOf4: z.boolean(),
    layoutMode: PdfLayoutModeSchema,
    totalPdfPages: z.number().int().min(1),
  }),
  pdfSha256: z.string().length(64),
  pdfBytesLength: z.number().int().min(1),
  preflightScore: z.number().int().min(0).max(100),
  preflightCheckedAt: z.iso.datetime({ offset: true }),
  shippingAddress: ShippingAddressSchema,
  idempotencyKey: z.string().min(1).max(160),
  generatedAt: z.iso.datetime({ offset: true }),
});

export type PrintJobManifest = z.infer<typeof PrintJobManifestSchema>;

export interface BuildManifestOptions {
  bleedMm?: number;
  cropMarks?: boolean;
  padToMultipleOf4?: boolean;
  layoutMode?: PdfLayoutMode;
  now?: Date;
}

export function computeManifestDigest(manifest: PrintJobManifest): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        manifestVersion: manifest.manifestVersion,
        orderId: manifest.orderId,
        orderNumber: manifest.orderNumber,
        storyId: manifest.storyId,
        bookFormat: manifest.bookFormat,
        quantity: manifest.quantity,
        pdfSpec: manifest.pdfSpec,
        pdfSha256: manifest.pdfSha256,
        pdfBytesLength: manifest.pdfBytesLength,
      }),
      'utf8',
    )
    .digest('hex');
}

export async function buildPrintJobManifest(
  order: OrderRecord,
  story: StoryRecord,
  options: BuildManifestOptions = {},
): Promise<{ manifest: PrintJobManifest; pdfBytes: Uint8Array; digest: string }> {
  if (order.paymentStatus !== 'paid') {
    throw new OrderGuardrailError(
      'Manifest druku wymaga opłaconego zamówienia.',
      'PAYMENT_REQUIRED',
      409,
    );
  }
  if (!order.customerApprovedAt) {
    throw new OrderGuardrailError(
      'Manifest druku wymaga zatwierdzenia podglądu przez klienta.',
      'CUSTOMER_APPROVAL_REQUIRED',
      409,
    );
  }
  if (!order.preflightPassed) {
    throw new OrderGuardrailError(
      'Manifest druku wymaga pozytywnego wyniku pre-flight.',
      'PREFLIGHT_REQUIRED',
      409,
    );
  }
  if (
    order.preflightStoryUpdatedAt &&
    order.preflightStoryUpdatedAt !== story.updatedAt
  ) {
    throw new OrderGuardrailError(
      'Bajka została zmieniona po wykonaniu pre-flight. Ponów pre-flight zamówienia przed pobraniem manifestu druku.',
      'STALE_PREFLIGHT',
      409,
    );
  }
  if (!order.shippingAddress) {
    throw new OrderGuardrailError(
      'Manifest druku wymaga uzupełnionego adresu dostawy.',
      'SHIPPING_ADDRESS_REQUIRED',
      409,
    );
  }

  const bleedMm = options.bleedMm ?? 3;
  const cropMarks = options.cropMarks ?? true;
  const padToMultipleOf4 = options.padToMultipleOf4 ?? true;
  const layoutMode: PdfLayoutMode = options.layoutMode ?? 'combined';

  const pdfOpts: PdfGenerationOptions = {
    bleedMm,
    cropMarks,
    padToMultipleOf4,
    layoutMode,
  };
  const pdfBytes = await generateStoryPdf(story, order.bookFormat, undefined, pdfOpts);
  const loadedPdf = await PDFDocument.load(pdfBytes);
  const totalPdfPages = loadedPdf.getPageCount();
  const pdfSha256 = crypto.createHash('sha256').update(pdfBytes).digest('hex');
  const nowIso = (options.now ?? new Date()).toISOString();

  const manifest: PrintJobManifest = PrintJobManifestSchema.parse({
    manifestVersion: 1,
    orderId: order.id,
    orderNumber: order.orderNumber,
    storyId: order.storyId,
    bookFormat: order.bookFormat,
    quantity: order.quantity,
    pdfSpec: {
      bleedMm,
      cropMarks,
      padToMultipleOf4,
      layoutMode,
      totalPdfPages,
    },
    pdfSha256,
    pdfBytesLength: pdfBytes.byteLength,
    preflightScore: order.preflightScore ?? 100,
    preflightCheckedAt: order.updatedAt,
    shippingAddress: order.shippingAddress,
    idempotencyKey: order.idempotencyKey ?? `print-${order.id}-v${order.version}`,
    generatedAt: nowIso,
  });

  const digest = computeManifestDigest(manifest);
  return { manifest, pdfBytes, digest };
}

/**
 * Runs deterministic preflight on an order's story, publishes `story.preflight_completed`,
 * transitions the order to `preflight_passed` or `preflight_failed`, pins
 * `preflightStoryUpdatedAt = story.updatedAt`, and persists atomically.
 */
export async function executeOrderPreflight(params: {
  orderId: string;
  actor?: OrderActor;
}): Promise<{ order: OrderRecord; preflight: PreflightReport } | null> {
  const repo = getOrderRepository();
  const order = await repo.getOrder(params.orderId);
  if (!order) {
    return null;
  }

  const story = await getStory(order.storyId);
  if (!story) {
    throw new OrderGuardrailError(
      `Nie znaleziono bajki ${order.storyId} powiązanej z zamówieniem ${order.orderNumber}.`,
      'PREFLIGHT_REQUIRED',
      409,
    );
  }

  const preflight = await runStoryPreflight(story, order.bookFormat);
  await getDomainEventBus().publish({
    type: 'story.preflight_completed',
    occurredAt: preflight.checkedAt,
    storyId: story.id,
    report: preflight,
  });

  const nextStatus = preflight.readyForPrint ? 'preflight_passed' : 'preflight_failed';
  const prevStatus = order.status;
  const transitioned = transitionOrder(order, nextStatus, {
    actor: params.actor ?? { kind: 'system', id: 'order-preflight-service' },
    reason: preflight.readyForPrint
      ? `Pre-flight zaliczony (wynik: ${preflight.score}/100)`
      : `Pre-flight niezaliczony (błędy: ${preflight.summary.errors}, wynik: ${preflight.score}/100)`,
    expectedVersion: order.version,
    patch: {
      preflightPassed: preflight.readyForPrint,
      preflightScore: preflight.score,
      preflightStoryUpdatedAt: story.updatedAt,
    },
  });

  const saved = await repo.saveOrder(transitioned, order.version);

  await getDomainEventBus().publish({
    type: 'order.status_changed',
    occurredAt: saved.updatedAt,
    orderId: saved.id,
    storyId: saved.storyId,
    from: prevStatus,
    to: saved.status,
    order: saved,
  });

  return { order: saved, preflight };
}

// =============================================================================
// Dry-Run Reference Adapters (Zero external vendor calls — safe for local/CI/staging)
// =============================================================================

export class DryRunPrintFulfillmentAdapter implements PrintFulfillmentAdapter {
  readonly providerId = 'dry-run-printer';
  private readonly jobs = new Map<string, PrintJobStatusResult>();

  async quote(request: PrintQuoteRequest): Promise<PrintQuoteResult> {
    const baseUnit = request.bookFormat === 'a4-landscape' ? 4900 : 4200;
    const pageAddon = Math.max(0, request.pageCount - 10) * 180;
    return {
      providerId: this.providerId,
      currency: 'PLN',
      unitCostMinorUnits: baseUnit + pageAddon,
      shippingCostMinorUnits: request.countryCode.toUpperCase() === 'PL' ? 1600 : 3900,
      estimatedProductionDays: 3,
      estimatedDeliveryDays: request.countryCode.toUpperCase() === 'PL' ? 2 : 5,
    };
  }

  async submitPrintJob(request: PrintSubmissionRequest): Promise<PrintSubmissionResult> {
    const now = new Date().toISOString();
    const externalOrderId = `dryrun-${request.orderId}-${request.idempotencyKey.slice(0, 8)}`;
    this.jobs.set(externalOrderId, {
      providerId: this.providerId,
      externalOrderId,
      status: 'queued',
      updatedAt: now,
    });
    return {
      providerId: this.providerId,
      externalOrderId,
      acceptedAt: now,
    };
  }

  async getPrintJobStatus(externalOrderId: string): Promise<PrintJobStatusResult> {
    return (
      this.jobs.get(externalOrderId) ?? {
        providerId: this.providerId,
        externalOrderId,
        status: 'error',
        updatedAt: new Date().toISOString(),
      }
    );
  }

  async cancelPrintJob(externalOrderId: string): Promise<{ cancelled: boolean }> {
    const existing = this.jobs.get(externalOrderId);
    if (!existing) {
      return { cancelled: false };
    }
    this.jobs.set(externalOrderId, {
      ...existing,
      status: 'cancelled',
      updatedAt: new Date().toISOString(),
    });
    return { cancelled: true };
  }
}

export class DryRunPaymentAdapter implements PaymentAdapter {
  readonly providerId = 'dry-run-payments';

  async createCheckoutSession(
    request: CheckoutSessionRequest,
  ): Promise<CheckoutSessionResult> {
    const sessionId = `dryrun_cs_${request.orderId}`;
    return {
      providerId: this.providerId,
      sessionId,
      checkoutUrl: `${request.successUrl}${request.successUrl.includes('?') ? '&' : '?'}dryRunSession=${encodeURIComponent(sessionId)}`,
    };
  }

  async refundPayment(params: {
    paymentReference: string;
    amountMinorUnits: number;
    reason?: string;
  }): Promise<{ refundId: string; status: 'succeeded' | 'pending' }> {
    return {
      refundId: `dryrun_rf_${params.paymentReference.slice(0, 24)}`,
      status: 'succeeded',
    };
  }
}

const fulfillmentLocks = new Map<string, Promise<void>>();

async function withFulfillmentLock<T>(orderId: string, fn: () => Promise<T>): Promise<T> {
  const prev = fulfillmentLocks.get(orderId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prev.catch(() => undefined).then(() => current);
  fulfillmentLocks.set(orderId, tail);

  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (fulfillmentLocks.get(orderId) === tail) {
      fulfillmentLocks.delete(orderId);
    }
  }
}

export class OrderFulfillmentService {
  private readonly printAdapter: PrintFulfillmentAdapter;

  constructor(printAdapter: PrintFulfillmentAdapter = new DryRunPrintFulfillmentAdapter()) {
    this.printAdapter = printAdapter;
  }

  async submitOrderToPrinter(params: {
    orderId: string;
    actor?: OrderActor;
    pdfUrlOrKey?: string;
  }): Promise<{ order: OrderRecord; manifest: PrintJobManifest; submission: PrintSubmissionResult }> {
    return withFulfillmentLock(params.orderId, async () => {
      const repo = getOrderRepository();
      const order = await repo.getOrder(params.orderId);
      if (!order) {
        throw new OrderGuardrailError(
          `Nie znaleziono zamówienia ${params.orderId}.`,
          'INVALID_TRANSITION',
          409,
        );
      }

      const story = await getStory(order.storyId);
      if (!story) {
        throw new OrderGuardrailError(
          `Nie znaleziono bajki ${order.storyId}.`,
          'PREFLIGHT_REQUIRED',
          409,
        );
      }

      const actor: OrderActor = params.actor ?? {
        kind: 'system',
        id: 'order-fulfillment-service',
      };

      // Pre-validate state machine transition & actor guardrails BEFORE any external
      // printer side effect so an invalid status or forbidden actor never submits a job.
      transitionOrder(order, 'submitted_to_printer', {
        actor,
        expectedVersion: order.version,
        currentStoryUpdatedAt: story.updatedAt,
      });

      const { manifest, digest } = await buildPrintJobManifest(order, story);
      const submission = await this.printAdapter.submitPrintJob({
        orderId: order.id,
        storyId: order.storyId,
        bookFormat: order.bookFormat,
        quantity: order.quantity,
        pdfUrlOrKey:
          params.pdfUrlOrKey ??
          `/api/stories/${order.storyId}/pdf?format=${order.bookFormat}&bleedMm=3&cropMarks=true&padToMultipleOf4=true`,
        shippingAddress: manifest.shippingAddress,
        idempotencyKey: manifest.idempotencyKey,
      });

      const prevStatus = order.status;
      const transitioned = transitionOrder(order, 'submitted_to_printer', {
        actor,
        reason: `Zlecono druk u dostawcy ${submission.providerId} (${submission.externalOrderId})`,
        expectedVersion: order.version,
        currentStoryUpdatedAt: story.updatedAt,
        patch: {
          printManifestDigest: digest,
          printProviderId: submission.providerId,
          printExternalOrderId: submission.externalOrderId,
        },
      });

      const saved = await repo.saveOrder(transitioned, order.version);

      await getDomainEventBus().publish({
        type: 'order.status_changed',
        occurredAt: saved.updatedAt,
        orderId: saved.id,
        storyId: saved.storyId,
        from: prevStatus,
        to: saved.status,
        order: saved,
      });

      return { order: saved, manifest, submission };
    });
  }
}
