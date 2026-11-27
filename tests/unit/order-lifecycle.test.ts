import { describe, expect, it } from 'vitest';
import {
  ORDER_NUMBER_REGEX,
  OrderGuardrailError,
  canTransitionOrder,
  createOrderDraft,
  transitionOrder,
} from '@/lib/orders/lifecycle';

const SAMPLE_ADDRESS = {
  recipientName: 'Anna Kowalska',
  line1: 'ul. Bajkowa 12/4',
  postalCode: '00-001',
  city: 'Warszawa',
  countryCode: 'PL',
  email: 'anna@example.com',
};

describe('Order lifecycle state machine & hardened guardrails', () => {
  it('completes a valid end-to-end order lifecycle with monotonic versions and full audit trail', () => {
    let order = createOrderDraft({
      id: 'ord-zosia-0001',
      storyId: 'zosia-story-001',
      bookFormat: 'square',
      quantity: 1,
      totalMinorUnits: 12900,
      shippingAddress: SAMPLE_ADDRESS,
    });
    expect(order.orderNumber).toMatch(ORDER_NUMBER_REGEX);
    expect(order.version).toBe(1);
    expect(order.customerLookupHash).toHaveLength(64);

    order = transitionOrder(order, 'awaiting_payment', {
      actor: { kind: 'customer', id: 'cust-1' },
      expectedVersion: 1,
    });
    expect(order.paymentStatus).toBe('pending');
    expect(order.version).toBe(2);

    order = transitionOrder(order, 'paid', {
      actor: { kind: 'payment-webhook', id: 'webhook-1' },
      expectedVersion: 2,
      patch: { paymentReference: 'pay_123' },
    });
    expect(order.paymentStatus).toBe('paid');

    order = transitionOrder(order, 'awaiting_customer_approval', {
      actor: { kind: 'system', id: 'orchestrator' },
    });

    order = transitionOrder(order, 'approved_for_print', {
      actor: { kind: 'customer', id: 'cust-1' },
      reason: 'Klient zatwierdził podgląd PDF',
    });
    expect(order.customerApprovedAt).toBeTruthy();

    order = transitionOrder(order, 'preflight_passed', {
      actor: { kind: 'agent', id: 'preflight-agent' },
      patch: {
        preflightScore: 96,
        preflightStoryUpdatedAt: '2026-11-27T10:00:00.000Z',
      },
    });
    expect(order.preflightPassed).toBe(true);

    order = transitionOrder(order, 'submitted_to_printer', {
      actor: { kind: 'agent', id: 'fulfillment-agent' },
      currentStoryUpdatedAt: '2026-11-27T10:00:00.000Z',
      patch: {
        printProviderId: 'print-house-a',
        printExternalOrderId: 'ext-9876',
      },
    });

    order = transitionOrder(order, 'in_production', {
      actor: { kind: 'printer-webhook', id: 'print-house-a' },
    });
    order = transitionOrder(order, 'shipped', {
      actor: { kind: 'printer-webhook', id: 'print-house-a' },
      patch: { trackingNumber: 'PL123456789' },
    });
    order = transitionOrder(order, 'delivered', {
      actor: { kind: 'printer-webhook', id: 'print-house-a' },
    });

    expect(order.status).toBe('delivered');
    expect(order.version).toBe(10);
    expect(order.auditLog).toHaveLength(9);
  });

  it('enforces strict actor allowlists for paid, approved_for_print, printer webhooks, and refunds', () => {
    let order = createOrderDraft({
      id: 'ord-guard-0001',
      storyId: 'zosia-story-001',
      bookFormat: 'square',
      totalMinorUnits: 9900,
      shippingAddress: SAMPLE_ADDRESS,
    });
    order = transitionOrder(order, 'awaiting_payment', {
      actor: { kind: 'customer', id: 'cust-1' },
    });

    // Neither agent nor customer may confirm payment (403)
    for (const actor of [
      { kind: 'agent' as const, id: 'chat-agent' },
      { kind: 'customer' as const, id: 'cust-1' },
    ]) {
      let caught: unknown;
      try {
        transitionOrder(order, 'paid', {
          actor,
          patch: { paymentReference: 'pay_forged' },
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(OrderGuardrailError);
      expect((caught as OrderGuardrailError).httpStatus).toBe(403);
    }

    // Missing paymentReference rejected with 422
    expect(() =>
      transitionOrder(order, 'paid', {
        actor: { kind: 'payment-webhook', id: 'pay-hook' },
      }),
    ).toThrowError(/paymentReference/);

    order = transitionOrder(order, 'paid', {
      actor: { kind: 'payment-webhook', id: 'pay-hook' },
      patch: { paymentReference: 'pay_legit_1' },
    });

    // Neither agent nor system may forge customer print approval (403)
    for (const actor of [
      { kind: 'agent' as const, id: 'chat-agent' },
      { kind: 'system' as const, id: 'sys-bot' },
    ]) {
      let caught: unknown;
      try {
        transitionOrder(order, 'approved_for_print', { actor });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(OrderGuardrailError);
      expect((caught as OrderGuardrailError).httpStatus).toBe(403);
    }
  });

  it('enforces payment, approval, fresh preflight, shippingAddress, and prevents paid-cancel dead-end', () => {
    const base = createOrderDraft({
      id: 'ord-guard-0002',
      storyId: 'zosia-story-001',
      bookFormat: 'square',
      totalMinorUnits: 14900,
    });

    expect(canTransitionOrder('draft', 'submitted_to_printer')).toBe(false);
    expect(canTransitionOrder('submitted_to_printer', 'cancelled')).toBe(false);

    // Missing shippingAddress blocked (409)
    const readyWithoutAddress = {
      ...base,
      status: 'preflight_passed' as const,
      paymentStatus: 'paid' as const,
      paymentReference: 'pay_1',
      customerApprovedAt: '2026-11-27T09:00:00.000Z',
      preflightPassed: true,
      preflightStoryUpdatedAt: '2026-11-27T08:00:00.000Z',
    };
    expect(() =>
      transitionOrder(readyWithoutAddress, 'submitted_to_printer', {
        actor: { kind: 'system', id: 'fulfillment-bot' },
      }),
    ).toThrowError(/adresu dostawy/);

    // Stale preflight blocked when story was edited afterwards (409)
    const readyWithAddress = {
      ...readyWithoutAddress,
      shippingAddress: SAMPLE_ADDRESS,
    };
    expect(() =>
      transitionOrder(readyWithAddress, 'submitted_to_printer', {
        actor: { kind: 'system', id: 'fulfillment-bot' },
        currentStoryUpdatedAt: '2026-11-27T09:30:00.000Z',
      }),
    ).toThrowError(/zmodyfikowana po ostatnim pre-flight/);
  });

  it('caps autonomous agent refunds strictly by policy and enforces optimistic version locking', () => {
    let order = createOrderDraft({
      id: 'ord-refund-0001',
      storyId: 'zosia-story-001',
      bookFormat: 'square',
      totalMinorUnits: 12900,
    });
    order = transitionOrder(order, 'awaiting_payment', {
      actor: { kind: 'customer', id: 'cust-1' },
    });
    order = transitionOrder(order, 'paid', {
      actor: { kind: 'payment-webhook', id: 'pay-hook' },
      patch: { paymentReference: 'pay_ref_1' },
    });

    // Version conflict returns 409
    let versionErr: unknown;
    try {
      transitionOrder(order, 'approved_for_print', {
        actor: { kind: 'customer', id: 'cust-1' },
        expectedVersion: 1,
      });
    } catch (err) {
      versionErr = err;
    }
    expect(versionErr).toBeInstanceOf(OrderGuardrailError);
    expect((versionErr as OrderGuardrailError).code).toBe('VERSION_CONFLICT');
    expect((versionErr as OrderGuardrailError).httpStatus).toBe(409);

    // Agent refund blocked by default cap (0)
    expect(() =>
      transitionOrder(order, 'refunded', {
        actor: { kind: 'agent', id: 'support-agent' },
        reason: 'Klient poprosił o zwrot',
      }),
    ).toThrowError(/powyżej limitu/);

    // Customer refund blocked (403)
    expect(() =>
      transitionOrder(order, 'refunded', {
        actor: { kind: 'customer', id: 'cust-1' },
      }),
    ).toThrowError(OrderGuardrailError);

    // Human admin can approve refund
    const refunded = transitionOrder(order, 'refunded', {
      actor: { kind: 'admin', id: 'owner' },
      reason: 'Zwrot zatwierdzony przez właściciela',
    });
    expect(refunded.status).toBe('refunded');
    expect(refunded.paymentStatus).toBe('refunded');
  });
});
