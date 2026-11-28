import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as approveOrderRoute } from '@/app/api/orders/[id]/approve/route';
import { POST as cancelOrderRoute } from '@/app/api/orders/[id]/cancel/route';
import { GET as printManifestRoute } from '@/app/api/orders/[id]/print-manifest/route';
import { POST as refundOrderRoute } from '@/app/api/orders/[id]/refund/route';
import { POST as transitionOrderRoute } from '@/app/api/orders/[id]/transitions/route';
import { POST as postOrdersRoute } from '@/app/api/orders/route';
import { POST as supportInquiriesRoute } from '@/app/api/support/inquiries/route';
import { POST as supportOrderStatusRoute } from '@/app/api/support/order-status/route';
import {
  DryRunPrintFulfillmentAdapter,
  OrderFulfillmentService,
} from '@/lib/orders/fulfillment';
import {
  resetIdempotencyStore,
  setIdempotencyStore,
  type IdempotencyStore,
} from '@/lib/orders/idempotency';
import {
  createOrderDraft,
  transitionOrder,
  type OrderRecord,
} from '@/lib/orders/lifecycle';
import { getOrderRepository, resetOrderRepository } from '@/lib/orders/repository';
import {
  EnvBearerTokenGuard,
  UnauthorizedError,
  resetOperatorAuthGuard,
  setOperatorAuthGuard,
} from '@/lib/security/operator-guard';
import {
  InMemoryRateLimiter,
  resetRateLimiter,
  setRateLimiter,
} from '@/lib/security/rate-limit';
import { resetStorageRootCache } from '@/lib/storage/paths';
import { saveStory } from '@/lib/storage/store';
import type { StoryRecord } from '@/lib/types/story';

function buildReadyStory(id: string, bookFormat: StoryRecord['bookFormat'] = 'square'): StoryRecord {
  const now = new Date().toISOString();
  return {
    id,
    createdAt: now,
    updatedAt: now,
    provider: 'demo',
    generationMode: 'full',
    generationStage: 'complete',
    bookFormat,
    title: 'Zosia i Zimowa Latarnia',
    subtitle: 'Opowieść dla Zosi',
    dedicationText: 'Dla kochanej Zosi!',
    backCoverBlurb: 'Ciepła opowieść o odwadze.',
    characterBible: 'Zosia w żółtym płaszczyku',
    coverPrompt: 'Cover',
    coverFilename: null,
    demoCoverPath: '/demo-art/cover.jpg',
    coverStatus: 'ready',
    referencePhotos: [],
    modelsUsed: {
      textModel: 'demo-text',
      imageModel: 'demo-image',
    },
    input: {
      childName: 'Zosia',
      childAge: 5,
      gender: 'girl',
      theme: 'Zimowa wyprawa z latarnią',
      artStyle: 'watercolor',
      mood: 'warm-cozy',
      pageCount: 6,
    },
    pages: Array.from({ length: 6 }, (_, idx) => ({
      pageNumber: idx + 1,
      chapterTitle: `Rozdział ${idx + 1}`,
      text: `Zosia szła przez cichy ogród i odkryła piękną gwiazdkę numer ${idx + 1}.`,
      imagePrompt: `Scene ${idx + 1}`,
      imageStatus: 'ready' as const,
      imageFilename: null,
      demoAssetPath: `/demo-art/page-${String(idx + 1).padStart(2, '0')}.jpg`,
    })),
  };
}

describe('Security & integrity review fixes', () => {
  let tmpDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bajkokreator-sec-fixes-'));
    originalDataDir = process.env.BAJKOKREATOR_DATA_DIR;
    process.env.BAJKOKREATOR_DATA_DIR = tmpDir;
    resetStorageRootCache();
    resetOperatorAuthGuard();
    resetOrderRepository();
    resetIdempotencyStore();
    resetRateLimiter();
  });

  afterEach(async () => {
    resetOperatorAuthGuard();
    resetOrderRepository();
    resetIdempotencyStore();
    resetRateLimiter();
    if (originalDataDir === undefined) {
      delete process.env.BAJKOKREATOR_DATA_DIR;
    } else {
      process.env.BAJKOKREATOR_DATA_DIR = originalDataDir;
    }
    resetStorageRootCache();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('EnvBearerTokenGuard fails closed in NODE_ENV=production unless explicitly opted out', async () => {
    const prodGuard = new EnvBearerTokenGuard({ NODE_ENV: 'production' });
    await expect(
      prodGuard.authenticate(new Request('http://localhost/api/ops/summary')),
    ).rejects.toThrow(UnauthorizedError);

    const optOutGuard = new EnvBearerTokenGuard({
      NODE_ENV: 'production',
      BAJKOKREATOR_ALLOW_UNAUTHENTICATED_OPS: 'true',
    });
    const identity = await optOutGuard.authenticate(
      new Request('http://localhost/api/ops/summary'),
    );
    expect(identity.authMethod).toBe('dev-bypass');
  });

  it('prevents an agent token from spoofing admin/customer actors on transitions, refund, and cancel', async () => {
    const story = buildReadyStory('sec-story-actor-1');
    await saveStory(story);

    let order = createOrderDraft({
      storyId: story.id,
      bookFormat: 'square',
      quantity: 1,
      totalMinorUnits: 12900,
      shippingAddress: {
        recipientName: 'Anna Kowalska',
        line1: 'ul. Lipowa 1',
        postalCode: '00-001',
        city: 'Warszawa',
        countryCode: 'PL',
        email: 'anna@example.com',
      },
    });
    order = transitionOrder(order, 'awaiting_payment', {
      actor: { kind: 'customer', id: 'c1' },
    });
    order = transitionOrder(order, 'paid', {
      actor: { kind: 'payment-webhook', id: 'wh' },
      patch: { paymentReference: 'pay_sec_1' },
    });
    await getOrderRepository().createOrder(order);

    setOperatorAuthGuard(
      new EnvBearerTokenGuard({
        BAJKOKREATOR_OPS_TOKEN: 'agent-secret',
        BAJKOKREATOR_OPS_TOKEN_ROLE: 'agent',
      }),
    );
    const agentHeaders = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer agent-secret',
    };

    // 1. Agent trying to spoof admin on /transitions
    const spoofTransition = await transitionOrderRoute(
      new Request(`http://localhost/api/orders/${order.id}/transitions`, {
        method: 'POST',
        headers: agentHeaders,
        body: JSON.stringify({
          nextStatus: 'approved_for_print',
          actor: { kind: 'admin', id: 'fake-admin' },
        }),
      }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect(spoofTransition.status).toBe(403);

    // 2. Agent sending empty body to /refund must NOT default to admin
    const emptyRefund = await refundOrderRoute(
      new Request(`http://localhost/api/orders/${order.id}/refund`, {
        method: 'POST',
        headers: agentHeaders,
        body: '{}',
      }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect(emptyRefund.status).toBe(403);

    // 3. Agent trying to spoof admin on /refund
    const spoofRefund = await refundOrderRoute(
      new Request(`http://localhost/api/orders/${order.id}/refund`, {
        method: 'POST',
        headers: agentHeaders,
        body: JSON.stringify({ actor: { kind: 'admin', id: 'fake-admin' } }),
      }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect(spoofRefund.status).toBe(403);

    // 4. Agent trying to spoof admin on /cancel
    const spoofCancel = await cancelOrderRoute(
      new Request(`http://localhost/api/orders/${order.id}/cancel`, {
        method: 'POST',
        headers: agentHeaders,
        body: JSON.stringify({ actor: { kind: 'admin', id: 'fake-admin' } }),
      }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect(spoofCancel.status).toBe(403);
  });

  it('requires operator auth or customer verification on /approve and strips shippingAddress PII for customer self-service', async () => {
    const story = buildReadyStory('sec-story-approve-1');
    await saveStory(story);

    let order = createOrderDraft({
      storyId: story.id,
      bookFormat: 'square',
      quantity: 1,
      totalMinorUnits: 12900,
      shippingAddress: {
        recipientName: 'Jan Nowak',
        line1: 'ul. Tajna 99',
        postalCode: '30-001',
        city: 'Kraków',
        countryCode: 'PL',
        email: 'jan@example.com',
        phone: '+48500111222',
      },
    });
    order = transitionOrder(order, 'awaiting_payment', {
      actor: { kind: 'customer', id: 'c1' },
    });
    order = transitionOrder(order, 'paid', {
      actor: { kind: 'payment-webhook', id: 'wh' },
      patch: { paymentReference: 'pay_app_1' },
    });
    await getOrderRepository().createOrder(order);

    setOperatorAuthGuard(
      new EnvBearerTokenGuard({
        BAJKOKREATOR_OPS_TOKEN: 'ops-secret',
        BAJKOKREATOR_OPS_TOKEN_ROLE: 'admin',
      }),
    );

    // Unauthenticated without verification -> 401
    const unauth = await approveOrderRoute(
      new Request(`http://localhost/api/orders/${order.orderNumber}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
      { params: Promise.resolve({ id: order.orderNumber }) },
    );
    expect(unauth.status).toBe(401);

    // Wrong customer verification -> indistinguishable 404
    const wrongVer = await approveOrderRoute(
      new Request(`http://localhost/api/orders/${order.orderNumber}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verification: 'wrong@example.com' }),
      }),
      { params: Promise.resolve({ id: order.orderNumber }) },
    );
    expect(wrongVer.status).toBe(404);

    // Valid customer verification -> 200 and shippingAddress is stripped
    const okVer = await approveOrderRoute(
      new Request(`http://localhost/api/orders/${order.orderNumber}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verification: 'jan@example.com' }),
      }),
      { params: Promise.resolve({ id: order.orderNumber }) },
    );
    expect(okVer.status).toBe(200);
    const body = (await okVer.json()) as { order: Partial<OrderRecord> };
    expect(body.order.status).toBe('approved_for_print');
    expect(body.order.shippingAddress).toBeUndefined();
  });

  it('computes authoritative server-side price, serializes concurrent idempotent creates, and checks fallback digest', async () => {
    const story = buildReadyStory('sec-story-orders-1', 'a4-landscape');
    await saveStory(story);

    const payload = {
      storyId: story.id,
      bookFormat: 'a4-landscape' as const,
      quantity: 2,
      totalMinorUnits: 0, // Tampered client price must be ignored
    };

    // Concurrent duplicate requests with same Idempotency-Key must produce a single order
    const [res1, res2] = await Promise.all([
      postOrdersRoute(
        new Request('http://localhost/api/orders', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': 'idem-race-001',
          },
          body: JSON.stringify(payload),
        }),
      ),
      postOrdersRoute(
        new Request('http://localhost/api/orders', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': 'idem-race-001',
          },
          body: JSON.stringify(payload),
        }),
      ),
    ]);

    const body1 = (await res1.json()) as { order: OrderRecord };
    const body2 = (await res2.json()) as { order: OrderRecord };
    expect(body1.order.id).toBe(body2.order.id);
    expect(body1.order.totalMinorUnits).toBe(14900 * 2);
    expect([res1.status, res2.status].sort()).toEqual([200, 201]);

    // Simulate empty idempotency store (e.g. restart with volatile store) and verify fallback checks digest
    const emptyStore: IdempotencyStore = {
      kind: 'empty-mock',
      get: async () => null,
      save: async () => undefined,
    };
    setIdempotencyStore(emptyStore);

    const conflictRes = await postOrdersRoute(
      new Request('http://localhost/api/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'idem-race-001',
        },
        body: JSON.stringify({ ...payload, quantity: 5 }),
      }),
    );
    expect(conflictRes.status).toBe(409);
  });

  it('OrderFulfillmentService validates state transition BEFORE calling external printAdapter.submitPrintJob', async () => {
    const story = buildReadyStory('sec-story-fulfill-1');
    await saveStory(story);

    // Order is still in `approved_for_print` (not `preflight_passed`) -> transition must fail BEFORE printer call
    let order = createOrderDraft({
      storyId: story.id,
      bookFormat: 'square',
      quantity: 1,
      totalMinorUnits: 12900,
      shippingAddress: {
        recipientName: 'Anna Kowalska',
        line1: 'ul. Lipowa 1',
        postalCode: '00-001',
        city: 'Warszawa',
        countryCode: 'PL',
        email: 'anna@example.com',
      },
    });
    order = transitionOrder(order, 'awaiting_payment', {
      actor: { kind: 'customer', id: 'c1' },
    });
    order = transitionOrder(order, 'paid', {
      actor: { kind: 'payment-webhook', id: 'wh' },
      patch: { paymentReference: 'pay_f_1' },
    });
    order = transitionOrder(order, 'approved_for_print', {
      actor: { kind: 'customer', id: 'c1' },
    });
    await getOrderRepository().createOrder(order);

    const adapter = new DryRunPrintFulfillmentAdapter();
    const submitSpy = vi.spyOn(adapter, 'submitPrintJob');
    const service = new OrderFulfillmentService(adapter);

    await expect(service.submitOrderToPrinter({ orderId: order.id })).rejects.toThrow();
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('GET /api/orders/[id]/print-manifest is read-only and does not mutate stored order', async () => {
    const story = buildReadyStory('sec-story-manifest-ro');
    await saveStory(story);

    let order = createOrderDraft({
      storyId: story.id,
      bookFormat: 'square',
      quantity: 1,
      totalMinorUnits: 12900,
      shippingAddress: {
        recipientName: 'Anna Kowalska',
        line1: 'ul. Lipowa 1',
        postalCode: '00-001',
        city: 'Warszawa',
        countryCode: 'PL',
        email: 'anna@example.com',
      },
    });
    order = transitionOrder(order, 'awaiting_payment', {
      actor: { kind: 'customer', id: 'c1' },
    });
    order = transitionOrder(order, 'paid', {
      actor: { kind: 'payment-webhook', id: 'wh' },
      patch: { paymentReference: 'pay_m_1' },
    });
    order = transitionOrder(order, 'approved_for_print', {
      actor: { kind: 'customer', id: 'c1' },
    });
    order = transitionOrder(order, 'preflight_passed', {
      actor: { kind: 'system', id: 'pf' },
      patch: { preflightPassed: true, preflightScore: 100, preflightStoryUpdatedAt: story.updatedAt },
    });
    await getOrderRepository().createOrder(order);

    const res = await printManifestRoute(
      new Request(`http://localhost/api/orders/${order.id}/print-manifest`),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect(res.status).toBe(200);

    const storedAfter = await getOrderRepository().getOrder(order.id);
    expect(storedAfter?.printManifestDigest).toBeUndefined();
    expect(storedAfter?.version).toBe(order.version);
  });

  it('enforces rate limits on public support endpoints', async () => {
    // Use a tiny rate limiter to verify wiring cleanly
    setRateLimiter({
      async check() {
        return {
          allowed: false,
          limit: 1,
          remaining: 0,
          resetAtIso: new Date(Date.now() + 60_000).toISOString(),
          retryAfterSeconds: 60,
        };
      },
    });

    const lookupRes = await supportOrderStatusRoute(
      new Request('http://localhost/api/support/order-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderNumber: 'BK-2026-ABCDEF', verification: '00-001' }),
      }),
    );
    expect(lookupRes.status).toBe(429);

    const inquiryRes = await supportInquiriesRoute(
      new Request('http://localhost/api/support/inquiries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerEmail: 'a@b.pl',
          subject: 'Pytanie',
          message: 'Treść pytania testowego',
        }),
      }),
    );
    expect(inquiryRes.status).toBe(429);

    // Restore normal limiter and verify payload size limit (413)
    setRateLimiter(new InMemoryRateLimiter());
    const hugeBody = JSON.stringify({
      orderNumber: 'BK-2026-ABCDEF',
      verification: 'x'.repeat(20_000),
    });
    const oversizedRes = await supportOrderStatusRoute(
      new Request('http://localhost/api/support/order-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: hugeBody,
      }),
    );
    expect(oversizedRes.status).toBe(413);
  });
});
