import crypto from 'node:crypto';
import { z } from 'zod';
import { BookFormatSchema, StoryIdSchema } from '@/lib/types/story';

// =============================================================================
// Vendor-Agnostic Order Lifecycle State Machine & Hard Financial/Print Guardrails
// Deterministic business rules live in TypeScript — never delegated to LLM prompts.
// =============================================================================

export const ORDER_STATUSES = [
  'draft',
  'awaiting_payment',
  'paid',
  'awaiting_customer_approval',
  'approved_for_print',
  'preflight_passed',
  'preflight_failed',
  'submitted_to_printer',
  'in_production',
  'shipped',
  'delivered',
  'cancelled',
  'refunded',
] as const;

export const PAYMENT_STATUSES = [
  'unpaid',
  'pending',
  'paid',
  'refunded',
] as const;

export const ACTOR_KINDS = [
  'customer',
  'admin',
  'agent',
  'system',
  'payment-webhook',
  'printer-webhook',
] as const;

export const ORDER_ID_REGEX = /^[a-z0-9][a-z0-9_-]{3,63}$/;
export const ORDER_NUMBER_REGEX = /^BK-\d{4}-[A-Z0-9]{6}$/;

export const OrderStatusSchema = z.enum(ORDER_STATUSES);
export const PaymentStatusSchema = z.enum(PAYMENT_STATUSES);
export const ActorKindSchema = z.enum(ACTOR_KINDS);

export type OrderStatus = z.infer<typeof OrderStatusSchema>;
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;
export type ActorKind = z.infer<typeof ActorKindSchema>;

const IsoTimestampSchema = z.iso.datetime({ offset: true });

export const OrderActorSchema = z.object({
  kind: ActorKindSchema,
  id: z.string().trim().min(1).max(120),
});
export type OrderActor = z.infer<typeof OrderActorSchema>;

export const OrderAuditEntrySchema = z.object({
  timestamp: IsoTimestampSchema,
  from: OrderStatusSchema,
  to: OrderStatusSchema,
  actor: OrderActorSchema,
  reason: z.string().trim().max(400).optional(),
});
export type OrderAuditEntry = z.infer<typeof OrderAuditEntrySchema>;

export const ShippingAddressSchema = z.object({
  recipientName: z.string().trim().min(2).max(120),
  line1: z.string().trim().min(2).max(160),
  line2: z.string().trim().max(160).optional(),
  postalCode: z.string().trim().min(3).max(20),
  city: z.string().trim().min(2).max(100),
  countryCode: z.string().trim().length(2).toUpperCase().default('PL'),
  email: z.email(),
  phone: z.string().trim().min(6).max(30).optional(),
});
export type ShippingAddress = z.infer<typeof ShippingAddressSchema>;

export const OrderRecordSchema = z.object({
  id: z.string().regex(ORDER_ID_REGEX),
  orderNumber: z.string().regex(ORDER_NUMBER_REGEX),
  version: z.number().int().min(1).default(1),
  storyId: StoryIdSchema,
  bookFormat: BookFormatSchema,
  quantity: z.number().int().min(1).max(100).default(1),
  currency: z.string().trim().length(3).toUpperCase().default('PLN'),
  /** Total order amount in minor units (e.g. grosze for PLN: 12900 = 129.00 PLN). */
  totalMinorUnits: z.number().int().min(0),
  status: OrderStatusSchema,
  paymentStatus: PaymentStatusSchema,
  paymentReference: z.string().trim().min(1).max(160).optional(),
  customerApprovedAt: IsoTimestampSchema.optional(),
  preflightPassed: z.boolean().default(false),
  preflightScore: z.number().int().min(0).max(100).optional(),
  preflightStoryUpdatedAt: IsoTimestampSchema.optional(),
  printManifestDigest: z.string().trim().min(16).max(128).optional(),
  idempotencyKey: z.string().trim().min(1).max(160).optional(),
  processedEventIds: z.array(z.string().trim().min(1).max(160)).default([]),
  customerLookupHash: z.string().trim().min(16).max(128).optional(),
  printProviderId: z.string().trim().min(1).max(80).optional(),
  printExternalOrderId: z.string().trim().min(1).max(160).optional(),
  trackingNumber: z.string().trim().min(1).max(160).optional(),
  trackingUrl: z.url().optional(),
  shippingAddress: ShippingAddressSchema.optional(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  auditLog: z.array(OrderAuditEntrySchema),
});

export type OrderRecord = z.infer<typeof OrderRecordSchema>;

/**
 * Paid orders cannot enter `cancelled` (preventing a paid-without-refund dead end);
 * once paid, cancellation must proceed through `refunded`.
 */
export const ALLOWED_ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  draft: ['awaiting_payment', 'cancelled'],
  awaiting_payment: ['paid', 'cancelled'],
  paid: ['awaiting_customer_approval', 'approved_for_print', 'refunded'],
  awaiting_customer_approval: ['approved_for_print', 'refunded'],
  approved_for_print: ['preflight_passed', 'preflight_failed', 'refunded'],
  preflight_failed: [
    'awaiting_customer_approval',
    'approved_for_print',
    'preflight_passed',
    'refunded',
  ],
  preflight_passed: ['submitted_to_printer', 'preflight_failed', 'refunded'],
  submitted_to_printer: ['in_production', 'refunded'],
  in_production: ['shipped', 'refunded'],
  shipped: ['delivered', 'refunded'],
  delivered: ['refunded'],
  cancelled: [],
  refunded: [],
};

/**
 * Statuses during which a story's reference photos must remain locked against
 * automatic GDPR/RODO retention sweeps because printing has not yet completed.
 */
export const ACTIVE_ORDER_RETENTION_LOCK_STATUSES: ReadonlySet<OrderStatus> = new Set([
  'awaiting_payment',
  'paid',
  'awaiting_customer_approval',
  'approved_for_print',
  'preflight_passed',
  'preflight_failed',
  'submitted_to_printer',
  'in_production',
]);

/**
 * Explicit per-target-status actor allowlist enforced in deterministic TypeScript.
 */
export const ALLOWED_ACTORS_FOR_TRANSITION: Readonly<
  Partial<Record<OrderStatus, readonly ActorKind[]>>
> = {
  paid: ['payment-webhook', 'admin'],
  approved_for_print: ['customer', 'admin'],
  preflight_passed: ['system', 'agent', 'admin'],
  preflight_failed: ['system', 'agent', 'admin'],
  submitted_to_printer: ['system', 'agent', 'admin'],
  in_production: ['printer-webhook', 'admin'],
  shipped: ['printer-webhook', 'admin'],
  delivered: ['printer-webhook', 'admin'],
  refunded: ['admin', 'payment-webhook', 'agent'],
};

export type OrderGuardrailErrorCode =
  | 'INVALID_TRANSITION'
  | 'PAYMENT_REQUIRED'
  | 'PAYMENT_REFERENCE_REQUIRED'
  | 'CUSTOMER_APPROVAL_REQUIRED'
  | 'PREFLIGHT_REQUIRED'
  | 'STALE_PREFLIGHT'
  | 'SHIPPING_ADDRESS_REQUIRED'
  | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'FORBIDDEN_ACTOR'
  | 'AGENT_FORBIDDEN_ACTION'
  | 'AGENT_REFUND_LIMIT_EXCEEDED';

export class OrderGuardrailError extends Error {
  readonly code: OrderGuardrailErrorCode;
  readonly httpStatus: 403 | 409 | 422;

  constructor(
    message: string,
    code: OrderGuardrailErrorCode,
    httpStatus?: 403 | 409 | 422,
  ) {
    super(message);
    this.name = 'OrderGuardrailError';
    this.code = code;
    this.httpStatus = httpStatus ?? defaultHttpStatusForCode(code);
    Object.setPrototypeOf(this, OrderGuardrailError.prototype);
  }
}

function defaultHttpStatusForCode(code: OrderGuardrailErrorCode): 403 | 409 | 422 {
  switch (code) {
    case 'FORBIDDEN_ACTOR':
    case 'AGENT_FORBIDDEN_ACTION':
    case 'AGENT_REFUND_LIMIT_EXCEEDED':
      return 403;
    case 'PAYMENT_REFERENCE_REQUIRED':
      return 422;
    default:
      return 409;
  }
}

export interface TransitionGuardrailPolicy {
  /**
   * Maximum refund amount (in minor units, e.g. grosze) that an automated agent
   * may execute without human admin approval. Default is 0 (agents cannot self-approve refunds).
   */
  maxAgentAutoRefundMinorUnits?: number;
}

export interface TransitionOrderOptions {
  actor: OrderActor;
  reason?: string;
  now?: Date;
  policy?: TransitionGuardrailPolicy;
  /** Optimistic concurrency check: throws 409 VERSION_CONFLICT if order.version !== expectedVersion. */
  expectedVersion?: number;
  /** Optional current story.updatedAt to detect stale preflight before print submission. */
  currentStoryUpdatedAt?: string;
  /** Optional metadata applied atomically with the state change. */
  patch?: Partial<
    Pick<
      OrderRecord,
      | 'paymentReference'
      | 'preflightPassed'
      | 'preflightScore'
      | 'preflightStoryUpdatedAt'
      | 'printManifestDigest'
      | 'printProviderId'
      | 'printExternalOrderId'
      | 'trackingNumber'
      | 'trackingUrl'
      | 'shippingAddress'
    >
  >;
}

const ORDER_NUMBER_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function generateOrderId(): string {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex');
  return `ord-${ts}-${rand}`;
}

export function generateOrderNumber(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const bytes = crypto.randomBytes(6);
  let suffix = '';
  for (let i = 0; i < 6; i += 1) {
    suffix += ORDER_NUMBER_ALPHABET[bytes[i] % ORDER_NUMBER_ALPHABET.length];
  }
  return `BK-${year}-${suffix}`;
}

export function normalizeVerificationToken(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '');
}

export function computeCustomerLookupHash(email: string, postalCode?: string): string {
  const normalizedEmail = normalizeVerificationToken(email);
  const normalizedPostal = postalCode ? normalizeVerificationToken(postalCode) : '';
  return crypto
    .createHash('sha256')
    .update(`bajkokreator-order-lookup-v1:${normalizedEmail}|${normalizedPostal}`)
    .digest('hex');
}

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED_ORDER_TRANSITIONS[from].includes(to);
}

export function isOrderLockingReferencePhotos(order: Pick<OrderRecord, 'status'>): boolean {
  return ACTIVE_ORDER_RETENTION_LOCK_STATUSES.has(order.status);
}

export function createOrderDraft(params: {
  id?: string;
  orderNumber?: string;
  storyId: string;
  bookFormat: OrderRecord['bookFormat'];
  quantity?: number;
  currency?: string;
  totalMinorUnits: number;
  shippingAddress?: ShippingAddress;
  idempotencyKey?: string;
  now?: Date;
}): OrderRecord {
  const now = params.now ?? new Date();
  const timestamp = now.toISOString();
  const id = params.id ?? generateOrderId();
  const orderNumber = params.orderNumber ?? generateOrderNumber(now);
  const customerLookupHash = params.shippingAddress
    ? computeCustomerLookupHash(
        params.shippingAddress.email,
        params.shippingAddress.postalCode,
      )
    : undefined;

  return OrderRecordSchema.parse({
    id,
    orderNumber,
    version: 1,
    storyId: params.storyId,
    bookFormat: params.bookFormat,
    quantity: params.quantity ?? 1,
    currency: params.currency ?? 'PLN',
    totalMinorUnits: params.totalMinorUnits,
    status: 'draft',
    paymentStatus: 'unpaid',
    preflightPassed: false,
    processedEventIds: [],
    ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
    ...(customerLookupHash ? { customerLookupHash } : {}),
    ...(params.shippingAddress ? { shippingAddress: params.shippingAddress } : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
    auditLog: [],
  });
}

/**
 * Applies a state transition to an OrderRecord while enforcing hard domain
 * guardrails (strict actor allowlists, optimistic concurrency, payment verification,
 * customer print sign-off, fresh preflight pass, shipping address presence,
 * and strict caps on autonomous agent refunds).
 */
export function transitionOrder(
  order: OrderRecord,
  nextStatus: OrderStatus,
  options: TransitionOrderOptions,
): OrderRecord {
  const actor = OrderActorSchema.parse(options.actor);
  const timestamp = (options.now ?? new Date()).toISOString();
  const maxAgentRefund = options.policy?.maxAgentAutoRefundMinorUnits ?? 0;

  if (
    options.expectedVersion !== undefined &&
    order.version !== options.expectedVersion
  ) {
    throw new OrderGuardrailError(
      `Konflikt wersji zamówienia (oczekiwano v${options.expectedVersion}, aktualna v${order.version}).`,
      'VERSION_CONFLICT',
      409,
    );
  }

  // Enforce strict per-transition actor allowlist before state checks for security clarity
  const allowedActors = ALLOWED_ACTORS_FOR_TRANSITION[nextStatus];
  if (allowedActors && !allowedActors.includes(actor.kind)) {
    const code: OrderGuardrailErrorCode =
      actor.kind === 'agent' ? 'AGENT_FORBIDDEN_ACTION' : 'FORBIDDEN_ACTOR';
    throw new OrderGuardrailError(
      `Aktor typu "${actor.kind}" nie ma uprawnień do przejścia zamówienia na status "${nextStatus}".`,
      code,
      403,
    );
  }

  // Cap automated agent refunds strictly by policy (default 0 -> always requires human admin)
  if (
    nextStatus === 'refunded' &&
    actor.kind === 'agent' &&
    order.totalMinorUnits > maxAgentRefund
  ) {
    throw new OrderGuardrailError(
      `Agent nie może samodzielnie zlecić zwrotu powyżej limitu (${maxAgentRefund} gr). Wymagana akceptacja administratora.`,
      'AGENT_REFUND_LIMIT_EXCEEDED',
      403,
    );
  }

  if (!canTransitionOrder(order.status, nextStatus)) {
    throw new OrderGuardrailError(
      `Niedozwolona zmiana statusu zamówienia: ${order.status} → ${nextStatus}.`,
      'INVALID_TRANSITION',
      409,
    );
  }

  const effectiveShippingAddress = options.patch?.shippingAddress ?? order.shippingAddress;
  const effectivePaymentRef = options.patch?.paymentReference ?? order.paymentReference;

  // Require paymentReference when marking an order as paid
  if (nextStatus === 'paid' && !effectivePaymentRef) {
    throw new OrderGuardrailError(
      'Potwierdzenie płatności wymaga identyfikatora transakcji (paymentReference).',
      'PAYMENT_REFERENCE_REQUIRED',
      422,
    );
  }

  // Submitting to printer requires verified payment, customer approval, fresh passed preflight, AND shipping address
  if (nextStatus === 'submitted_to_printer') {
    if (order.paymentStatus !== 'paid') {
      throw new OrderGuardrailError(
        'Nie można wysłać zamówienia do drukarni przed potwierdzeniem płatności.',
        'PAYMENT_REQUIRED',
        409,
      );
    }
    if (!order.customerApprovedAt) {
      throw new OrderGuardrailError(
        'Nie można wysłać zamówienia do drukarni bez zatwierdzenia podglądu przez klienta.',
        'CUSTOMER_APPROVAL_REQUIRED',
        409,
      );
    }
    const effectivePreflightPassed = options.patch?.preflightPassed ?? order.preflightPassed;
    if (!effectivePreflightPassed) {
      throw new OrderGuardrailError(
        'Nie można wysłać zamówienia do drukarni bez pozytywnego wyniku pre-flight.',
        'PREFLIGHT_REQUIRED',
        409,
      );
    }
    const pinnedStoryUpdatedAt =
      options.patch?.preflightStoryUpdatedAt ?? order.preflightStoryUpdatedAt;
    if (
      options.currentStoryUpdatedAt &&
      pinnedStoryUpdatedAt &&
      options.currentStoryUpdatedAt !== pinnedStoryUpdatedAt
    ) {
      throw new OrderGuardrailError(
        'Bajka została zmodyfikowana po ostatnim pre-flight. Wykonaj pre-flight ponownie przed wysłaniem do drukarni.',
        'STALE_PREFLIGHT',
        409,
      );
    }
    if (!effectiveShippingAddress) {
      throw new OrderGuardrailError(
        'Nie można wysłać zamówienia do drukarni bez uzupełnionego adresu dostawy.',
        'SHIPPING_ADDRESS_REQUIRED',
        409,
      );
    }
  }

  let nextPaymentStatus: PaymentStatus = order.paymentStatus;
  if (nextStatus === 'awaiting_payment' && nextPaymentStatus === 'unpaid') {
    nextPaymentStatus = 'pending';
  } else if (nextStatus === 'paid') {
    nextPaymentStatus = 'paid';
  } else if (nextStatus === 'refunded') {
    nextPaymentStatus = 'refunded';
  }

  const nextCustomerApprovedAt =
    nextStatus === 'approved_for_print'
      ? order.customerApprovedAt ?? timestamp
      : order.customerApprovedAt;

  const nextPreflightPassed =
    nextStatus === 'preflight_passed'
      ? true
      : nextStatus === 'preflight_failed'
        ? false
        : (options.patch?.preflightPassed ?? order.preflightPassed);

  const nextCustomerLookupHash = effectiveShippingAddress
    ? computeCustomerLookupHash(
        effectiveShippingAddress.email,
        effectiveShippingAddress.postalCode,
      )
    : order.customerLookupHash;

  const auditEntry: OrderAuditEntry = {
    timestamp,
    from: order.status,
    to: nextStatus,
    actor,
    ...(options.reason ? { reason: options.reason } : {}),
  };

  return OrderRecordSchema.parse({
    ...order,
    ...(options.patch ?? {}),
    version: order.version + 1,
    status: nextStatus,
    paymentStatus: nextPaymentStatus,
    ...(nextCustomerApprovedAt ? { customerApprovedAt: nextCustomerApprovedAt } : {}),
    ...(nextCustomerLookupHash ? { customerLookupHash: nextCustomerLookupHash } : {}),
    preflightPassed: nextPreflightPassed,
    updatedAt: timestamp,
    auditLog: [...order.auditLog, auditEntry],
  });
}
