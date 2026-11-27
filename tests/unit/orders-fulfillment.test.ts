import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET as getOrdersRoute, POST as postOrdersRoute } from '@/app/api/orders/route';
import { POST as approveOrderRoute } from '@/app/api/orders/[id]/approve/route';
import { POST as cancelOrderRoute } from '@/app/api/orders/[id]/cancel/route';
import { POST as preflightOrderRoute } from '@/app/api/orders/[id]/preflight/route';
import { GET as printManifestRoute } from '@/app/api/orders/[id]/print-manifest/route';
import { POST as refundOrderRoute } from '@/app/api/orders/[id]/refund/route';
import { POST as transitionOrderRoute } from '@/app/api/orders/[id]/transitions/route';
import { POST as postStoriesRoute } from '@/app/api/stories/route';
import { runRetentionSweep } from '@/lib/ops/retention';
import { buildOpsSummary } from '@/lib/ops/summary';
import {
  DryRunPaymentAdapter,
  DryRunPrintFulfillmentAdapter,
  OrderFulfillmentService,
} from '@/lib/orders/fulfillment';
import type { OrderRecord } from '@/lib/orders/lifecycle';
import {
  HmacSha256WebhookVerifier,
  ingestPaymentWebhookEvent,
  ingestPrinterWebhookEvent,
} from '@/lib/orders/webhooks';
import { resetStorageRootCache } from '@/lib/storage/paths';
import type { StoryRecord } from '@/lib/types/story';

let tempDir = '';
const origDataDir = process.env.BAJKOKREATOR_DATA_DIR;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bajkokreator-m3-test-'));
  process.env.BAJKOKREATOR_DATA_DIR = tempDir;
  resetStorageRootCache();
});

afterEach(async () => {
  if (origDataDir === undefined) {
    delete process.env.BAJKOKREATOR_DATA_DIR;
  } else {
    process.env.BAJKOKREATOR_DATA_DIR = origDataDir;
  }
  resetStorageRootCache();
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = '';
  }
});

async function createDemoStory(): Promise<StoryRecord> {
  const buf = await sharp({
    create: { width: 800, height: 800, channels: 3, background: { r: 210, g: 170, b: 130 } },
  })
    .jpeg({ quality: 85 })
    .toBuffer();

  const form = new FormData();
  form.append(
    'payload',
    JSON.stringify({
      childName: 'Zosia',
      childAge: 5,
      gender: 'girl',
      theme: 'Wyprawa do zaczarowanego lasu świetlików',
      artStyle: 'watercolor',
      mood: 'warm-cozy',
      pageCount: 4,
      provider: 'demo',
      generationMode: 'full',
      bookFormat: 'square',
    }),
  );
  form.append('photos', new File([new Uint8Array(buf)], 'zosia.jpg', { type: 'image/jpeg' }));

  const res = await postStoriesRoute(
    new Request('http://localhost/api/stories', { method: 'POST', body: form }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { story: StoryRecord }).story;
}

describe('M3 Orders API, Idempotency, Webhooks, Print Manifest & Ops Wiring', () => {
  it('supports idempotent order creation, replay-safe webhooks, print manifest, dry-run fulfillment, and retention lock', async () => {
    const story = await createDemoStory();

    const payload = {
      storyId: story.id,
      bookFormat: 'square',
      quantity: 1,
      totalMinorUnits: 12900,
      shippingAddress: {
        recipientName: 'Anna Kowalska',
        line1: 'ul. Bajkowa 12/4',
        postalCode: '00-001',
        city: 'Warszawa',
        countryCode: 'PL',
        email: 'anna@example.com',
      },
    };

    // 1. Idempotent POST /api/orders -> 201, replay -> 200, mutated payload -> 409
    const createRes = await postOrdersRoute(
      new Request('http://localhost/api/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'idem-m3-001',
        },
        body: JSON.stringify(payload),
      }),
    );
    expect(createRes.status).toBe(201);
    const created = ((await createRes.json()) as { order: OrderRecord }).order;

    const replayRes = await postOrdersRoute(
      new Request('http://localhost/api/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'idem-m3-001',
        },
        body: JSON.stringify(payload),
      }),
    );
    expect(replayRes.status).toBe(200);
    const replayed = ((await replayRes.json()) as { order: OrderRecord }).order;
    expect(replayed.id).toBe(created.id);

    const conflictRes = await postOrdersRoute(
      new Request('http://localhost/api/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'idem-m3-001',
        },
        body: JSON.stringify({ ...payload, quantity: 3 }),
      }),
    );
    expect(conflictRes.status).toBe(409);

    // 2. Advance to awaiting_payment and confirm via replay-safe payment webhook
    const pendingRes = await transitionOrderRoute(
      new Request(`http://localhost/api/orders/${created.id}/transitions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nextStatus: 'awaiting_payment',
          actor: { kind: 'customer', id: 'cust-1' },
        }),
      }),
      { params: Promise.resolve({ id: created.id }) },
    );
    expect(pendingRes.status).toBe(200);

    const verifier = new HmacSha256WebhookVerifier({
      providerId: 'dry-run-payments',
      secret: 'test-webhook-secret',
    });
    const ts = Math.floor(Date.now() / 1000);
    const rawWebhook = JSON.stringify({ eventId: 'evt-pay-1' });
    const sig = verifier.sign(rawWebhook, ts);
    expect(
      verifier.verify({
        rawBody: rawWebhook,
        signatureHeader: `sha256=${sig}`,
        timestampHeader: String(ts),
      }).valid,
    ).toBe(true);
    expect(
      verifier.verify({
        rawBody: rawWebhook,
        signatureHeader: 'sha256=' + '0'.repeat(64),
        timestampHeader: String(ts),
      }).valid,
    ).toBe(false);

    const payEvt = {
      eventId: 'evt-pay-1',
      providerId: 'dry-run-payments',
      orderId: created.id,
      type: 'payment.succeeded' as const,
      paymentReference: 'pay_m3_001',
      occurredAt: new Date().toISOString(),
    };
    const firstPay = await ingestPaymentWebhookEvent(payEvt);
    expect(firstPay.duplicate).toBe(false);
    expect(firstPay.order.status).toBe('paid');

    const dupPay = await ingestPaymentWebhookEvent(payEvt);
    expect(dupPay.duplicate).toBe(true);
    expect(dupPay.order.version).toBe(firstPay.order.version);

    // 3. Retention sweep must lock story reference photos while order is active
    const sweep = await runRetentionSweep({
      dryRun: false,
      maxAgeHoursAfterCreation: 0,
      now: new Date(Date.now() + 86_400_000),
    });
    expect(sweep.skippedLockedByOrder).toBe(1);
    expect(sweep.purged).toBe(0);

    // 4. Customer approves -> preflight passes -> print manifest generated
    const approveRes = await approveOrderRoute(
      new Request(`http://localhost/api/orders/${created.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor: { kind: 'customer', id: 'cust-1' } }),
      }),
      { params: Promise.resolve({ id: created.id }) },
    );
    expect(approveRes.status).toBe(200);

    const preflightRes = await preflightOrderRoute(
      new Request(`http://localhost/api/orders/${created.id}/preflight`, {
        method: 'POST',
      }),
      { params: Promise.resolve({ id: created.id }) },
    );
    expect(preflightRes.status).toBe(200);
    const pfBody = (await preflightRes.json()) as {
      order: OrderRecord;
      preflight: { readyForPrint: boolean };
    };
    expect(pfBody.preflight.readyForPrint).toBe(true);
    expect(pfBody.order.status).toBe('preflight_passed');

    const manifestRes = await printManifestRoute(
      new Request(`http://localhost/api/orders/${created.id}/print-manifest`),
      { params: Promise.resolve({ id: created.id }) },
    );
    expect(manifestRes.status).toBe(200);
    const manifestJson = (await manifestRes.json()) as {
      manifest: { pdfSha256: string; pdfSpec: { totalPdfPages: number; bleedMm: number } };
    };
    expect(manifestJson.manifest.pdfSha256).toHaveLength(64);
    expect(manifestJson.manifest.pdfSpec.bleedMm).toBe(3);
    expect(manifestJson.manifest.pdfSpec.totalPdfPages % 4).toBe(0);

    // 5. Dry-run fulfillment & printer webhook progression
    const printAdapter = new DryRunPrintFulfillmentAdapter();
    const quote = await printAdapter.quote({
      bookFormat: 'square',
      pageCount: 10,
      quantity: 1,
      countryCode: 'PL',
    });
    expect(quote.unitCostMinorUnits).toBeGreaterThan(0);

    const paymentAdapter = new DryRunPaymentAdapter();
    const checkout = await paymentAdapter.createCheckoutSession({
      orderId: created.id,
      amountMinorUnits: 12900,
      currency: 'PLN',
      customerEmail: 'anna@example.com',
      successUrl: 'http://localhost/orders',
      cancelUrl: 'http://localhost/orders',
      description: 'Bajka',
    });
    expect(checkout.sessionId).toContain(created.id);

    const fulfillment = new OrderFulfillmentService(printAdapter);
    const submitted = await fulfillment.submitOrderToPrinter({ orderId: created.id });
    expect(submitted.order.status).toBe('submitted_to_printer');

    const prod = await ingestPrinterWebhookEvent({
      eventId: 'evt-print-1',
      providerId: 'dry-run-printer',
      orderId: created.id,
      type: 'print.in_production',
      occurredAt: new Date().toISOString(),
    });
    expect(prod.order.status).toBe('in_production');

    // 6. Ops summary reflects live order metrics & GET /api/orders lists the order
    const summary = await buildOpsSummary();
    expect(summary.orders.available).toBe(true);
    expect(summary.orders.total).toBe(1);

    const listRes = await getOrdersRoute(
      new Request(`http://localhost/api/orders?storyId=${story.id}`),
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { orders: OrderRecord[] };
    expect(listBody.orders).toHaveLength(1);

    // 7. Cancel on paid/in_production order returns 409; agent refund returns 403; admin refund returns 200
    const badCancel = await cancelOrderRoute(
      new Request(`http://localhost/api/orders/${created.id}/cancel`, { method: 'POST' }),
      { params: Promise.resolve({ id: created.id }) },
    );
    expect(badCancel.status).toBe(409);

    const agentRefund = await refundOrderRoute(
      new Request(`http://localhost/api/orders/${created.id}/refund`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor: { kind: 'agent', id: 'support-bot' } }),
      }),
      { params: Promise.resolve({ id: created.id }) },
    );
    expect(agentRefund.status).toBe(403);

    const adminRefund = await refundOrderRoute(
      new Request(`http://localhost/api/orders/${created.id}/refund`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor: { kind: 'admin', id: 'owner' } }),
      }),
      { params: Promise.resolve({ id: created.id }) },
    );
    expect(adminRefund.status).toBe(200);
  });
});
