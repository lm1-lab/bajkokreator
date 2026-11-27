import { z } from 'zod';
import {
  normalizeVerificationToken,
  type OrderRecord,
  type OrderStatus,
  type PaymentStatus,
} from '@/lib/orders/lifecycle';
import { getOrderByIdOrNumber } from '@/lib/orders/repository';
import { constantTimeTokenEqual } from '@/lib/security/operator-guard';
import type { BookFormat } from '@/lib/types/story';

// =============================================================================
// Deterministic Customer Order-Status Lookup (PII-Minimized)
// Verifies orderNumber/orderId + (email OR postalCode) in constant time.
// Never returns street address, full email, recipient full name, or internal IDs.
// =============================================================================

export const OrderStatusLookupInputSchema = z.object({
  orderNumber: z.string().trim().min(3).max(80),
  verification: z.string().trim().min(3).max(160),
});

export type OrderStatusLookupInput = z.infer<typeof OrderStatusLookupInputSchema>;

export interface CustomerOrderStatusView {
  orderNumber: string;
  status: OrderStatus;
  statusLabelPl: string;
  nextStepPl: string;
  paymentStatus: PaymentStatus;
  bookFormat: BookFormat;
  quantity: number;
  customerApproved: boolean;
  preflightPassed: boolean;
  trackingNumber?: string;
  trackingUrl?: string;
  createdAt: string;
  updatedAt: string;
  timeline: Array<{
    status: OrderStatus;
    labelPl: string;
    timestamp: string;
  }>;
}

export const ORDER_STATUS_LABELS_PL: Readonly<
  Record<OrderStatus, { label: string; nextStep: string }>
> = {
  draft: {
    label: 'Szkic zamówienia',
    nextStep: 'Dokończ składanie zamówienia i przejdź do płatności.',
  },
  awaiting_payment: {
    label: 'Oczekuje na płatność',
    nextStep: 'Oczekujemy na potwierdzenie wpłaty od operatora płatności.',
  },
  paid: {
    label: 'Opłacone',
    nextStep: 'Zatwierdź podgląd książki do druku, aby uruchomić kontrolę techniczną.',
  },
  awaiting_customer_approval: {
    label: 'Oczekuje na zatwierdzenie podglądu',
    nextStep: 'Przejrzyj gotową bajkę i kliknij zatwierdzenie do druku.',
  },
  approved_for_print: {
    label: 'Zatwierdzone do druku',
    nextStep: 'Trwa automatyczna kontrola jakości poligraficznej (Pre-Flight).',
  },
  preflight_passed: {
    label: 'Pre-Flight zaliczony — gotowe do przekazania drukarni',
    nextStep: 'Zamówienie wkrótce zostanie przekazane do realizacji w drukarni.',
  },
  preflight_failed: {
    label: 'Wymagana poprawka przed drukiem',
    nextStep: 'Wykryto problem techniczny w pliku książki — popraw wskazane strony przed drukiem.',
  },
  submitted_to_printer: {
    label: 'Przekazano do drukarni',
    nextStep: 'Drukarnia przyjęła zlecenie do kolejki produkcyjnej.',
  },
  in_production: {
    label: 'W druku i oprawie',
    nextStep: 'Twoja książka jest obecnie drukowana i oprawiana.',
  },
  shipped: {
    label: 'Wysłane',
    nextStep: 'Przesyłka jest w drodze — skorzystaj z numeru śledzenia.',
  },
  delivered: {
    label: 'Dostarczone',
    nextStep: 'Zamówienie zostało doręczone. Miłego czytania!',
  },
  cancelled: {
    label: 'Anulowane',
    nextStep: 'Zamówienie zostało anulowane przed opłaceniem.',
  },
  refunded: {
    label: 'Zwrócone',
    nextStep: 'Środki za zamówienie zostały zwrócone.',
  },
};

function matchesOrderVerification(order: OrderRecord, rawVerification: string): boolean {
  if (!order.shippingAddress) {
    return false;
  }
  const provided = normalizeVerificationToken(rawVerification);
  if (!provided) {
    return false;
  }

  const expectedEmail = normalizeVerificationToken(order.shippingAddress.email);
  const expectedPostal = normalizeVerificationToken(order.shippingAddress.postalCode);

  const emailMatch = constantTimeTokenEqual(provided, expectedEmail);
  const postalMatch = constantTimeTokenEqual(provided, expectedPostal);
  return emailMatch || postalMatch;
}

export function projectCustomerOrderStatusView(
  order: OrderRecord,
): CustomerOrderStatusView {
  const statusInfo = ORDER_STATUS_LABELS_PL[order.status];
  return {
    orderNumber: order.orderNumber,
    status: order.status,
    statusLabelPl: statusInfo.label,
    nextStepPl: statusInfo.nextStep,
    paymentStatus: order.paymentStatus,
    bookFormat: order.bookFormat,
    quantity: order.quantity,
    customerApproved: Boolean(order.customerApprovedAt),
    preflightPassed: order.preflightPassed,
    ...(order.trackingNumber ? { trackingNumber: order.trackingNumber } : {}),
    ...(order.trackingUrl ? { trackingUrl: order.trackingUrl } : {}),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    timeline: order.auditLog.map((entry) => ({
      status: entry.to,
      labelPl: ORDER_STATUS_LABELS_PL[entry.to].label,
      timestamp: entry.timestamp,
    })),
  };
}

export async function lookupCustomerOrderStatus(
  input: OrderStatusLookupInput,
): Promise<CustomerOrderStatusView | null> {
  const parsed = OrderStatusLookupInputSchema.parse(input);
  const order = await getOrderByIdOrNumber(parsed.orderNumber);
  if (!order) {
    return null;
  }

  if (!matchesOrderVerification(order, parsed.verification)) {
    return null;
  }

  return projectCustomerOrderStatusView(order);
}
