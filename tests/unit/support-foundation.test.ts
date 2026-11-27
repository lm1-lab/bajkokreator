import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET as getHealthRoute } from '@/app/api/health/route';
import { GET as getSupportInquiries, POST as postSupportInquiry } from '@/app/api/support/inquiries/route';
import {
  GET as getSupportInquiryById,
  PATCH as patchSupportInquiryById,
} from '@/app/api/support/inquiries/[id]/route';
import { GET as getSupportKb } from '@/app/api/support/kb/route';
import { POST as postOrderStatus } from '@/app/api/support/order-status/route';
import { createOrderDraft } from '@/lib/orders/lifecycle';
import { getOrderRepository } from '@/lib/orders/repository';
import { resetStorageRootCache } from '@/lib/storage/paths';
import { redactSupportPii } from '@/lib/support/guardrails';

let tempDir = '';
const origDataDir = process.env.BAJKOKREATOR_DATA_DIR;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bajkokreator-m5-test-'));
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

describe('M5 Customer Support, Knowledge Base, Order Lookup & Escalation Guardrails', () => {
  it('exposes Knowledge Base search/category filtering and wires KB check into /api/health', async () => {
    const healthRes = await getHealthRoute(new Request('http://localhost/api/health'));
    expect(healthRes.status).toBe(200);
    const healthJson = (await healthRes.json()) as {
      checks: { knowledgeBase?: { status: string } };
    };
    expect(healthJson.checks.knowledgeBase?.status).toBe('pass');

    const kbAllRes = await getSupportKb(new Request('http://localhost/api/support/kb'));
    expect(kbAllRes.status).toBe(200);
    const kbAll = (await kbAllRes.json()) as {
      articles: Array<{ id: string; category: string; policyStatus: string }>;
      total: number;
    };
    expect(kbAll.total).toBeGreaterThanOrEqual(6);

    const kbRodoRes = await getSupportKb(new Request('http://localhost/api/support/kb?q=RODO'));
    expect(kbRodoRes.status).toBe(200);
    const kbRodo = (await kbRodoRes.json()) as {
      articles: Array<{ id: string }>;
      total: number;
    };
    expect(kbRodo.total).toBeGreaterThanOrEqual(1);
    expect(kbRodo.articles[0].id).toBe('rodo-privacy-and-photo-deletion');
  });

  it('verifies order status by email or postal code without leaking PII and returns indistinguishable 404s', async () => {
    const order = await getOrderRepository().createOrder(
      createOrderDraft({
        storyId: 'zosia-support-01',
        bookFormat: 'square',
        totalMinorUnits: 12900,
        shippingAddress: {
          recipientName: 'Katarzyna Tajna',
          line1: 'ul. Ukryta 99',
          postalCode: '50-123',
          city: 'Wrocław',
          countryCode: 'PL',
          email: 'katarzyna.tajna@example.com',
        },
      }),
    );

    const byEmail = await postOrderStatus(
      new Request('http://localhost/api/support/order-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderNumber: order.orderNumber,
          verification: 'KATARZYNA.TAJNA@example.com',
        }),
      }),
    );
    expect(byEmail.status).toBe(200);
    const byEmailBody = (await byEmail.json()) as {
      found: boolean;
      statusView: { orderNumber: string };
    };
    expect(byEmailBody.found).toBe(true);
    expect(byEmailBody.statusView.orderNumber).toBe(order.orderNumber);
    const viewStr = JSON.stringify(byEmailBody.statusView);
    expect(viewStr).not.toContain('ul. Ukryta 99');
    expect(viewStr).not.toContain('katarzyna.tajna@example.com');
    expect(viewStr).not.toContain('Katarzyna Tajna');

    const byPostal = await postOrderStatus(
      new Request('http://localhost/api/support/order-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderNumber: order.orderNumber,
          verification: '50-123',
        }),
      }),
    );
    expect(byPostal.status).toBe(200);

    // Indistinguishable 404s for wrong email, wrong postal, and unknown orderNumber
    const negativeCodes: string[] = [];
    for (const payload of [
      { orderNumber: order.orderNumber, verification: 'wrong@example.com' },
      { orderNumber: order.orderNumber, verification: '00-000' },
      { orderNumber: 'BK-2099-ZZZZZZ', verification: 'katarzyna.tajna@example.com' },
    ]) {
      const res = await postOrderStatus(
        new Request('http://localhost/api/support/order-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }),
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { code: string; error: string };
      negativeCodes.push(body.code);
      expect(JSON.stringify(body)).not.toContain('Katarzyna');
      expect(JSON.stringify(body)).not.toContain(order.id);
    }
    expect(new Set(negativeCodes).size).toBe(1);
  });

  it('enforces mandatory escalation for refund/RODO/defect/chargeback inquiries and redacts PII from tickets', async () => {
    expect(redactSupportPii('PESEL 92030456789 tel +48 600 987 654')).not.toContain('92030456789');

    const routineRes = await postSupportInquiry(
      new Request('http://localhost/api/support/inquiries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerEmail: 'pytajacy@example.com',
          subject: 'Formaty książek',
          message: 'Jakie wymiary ma książka kwadratowa i jak przygotować zdjęcia?',
        }),
      }),
    );
    expect(routineRes.status).toBe(201);
    const routineBody = (await routineRes.json()) as {
      ticket: { id: string; status: string };
      escalation: { shouldEscalate: boolean };
      suggestedArticles: unknown[];
    };
    expect(routineBody.escalation.shouldEscalate).toBe(false);
    expect(routineBody.suggestedArticles.length).toBeGreaterThanOrEqual(1);

    const urgentRes = await postSupportInquiry(
      new Request('http://localhost/api/support/inquiries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerEmail: 'klient@example.com',
          subject: 'Zwrot środków i UOKiK',
          message:
            'Żądam zwrotu 129 zł. Kontakt: +48 600 987 654, jan.kowalski@example.com, PESEL 92030456789.',
        }),
      }),
    );
    expect(urgentRes.status).toBe(201);
    const urgentBody = (await urgentRes.json()) as {
      ticket: { id: string; status: string };
      escalation: { shouldEscalate: boolean; reasons: string[] };
    };
    expect(urgentBody.escalation.shouldEscalate).toBe(true);
    expect(urgentBody.escalation.reasons).toContain('refund_or_compensation');
    expect(urgentBody.escalation.reasons).toContain('legal_or_chargeback_threat');
    expect(JSON.stringify(urgentBody.ticket)).not.toContain('92030456789');
    expect(JSON.stringify(urgentBody.ticket)).not.toContain('600 987 654');

    const getRes = await getSupportInquiryById(
      new Request(`http://localhost/api/support/inquiries/${urgentBody.ticket.id}`),
      { params: Promise.resolve({ id: urgentBody.ticket.id }) },
    );
    expect(getRes.status).toBe(200);
    const getText = await getRes.text();
    expect(getText).not.toContain('92030456789');
    expect(getText).not.toContain('600 987 654');

    const patchRes = await patchSupportInquiryById(
      new Request(`http://localhost/api/support/inquiries/${urgentBody.ticket.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'resolved', operatorNotes: 'Sprawa wyjaśniona' }),
      }),
      { params: Promise.resolve({ id: urgentBody.ticket.id }) },
    );
    expect(patchRes.status).toBe(200);

    const listRes = await getSupportInquiries(
      new Request('http://localhost/api/support/inquiries?status=resolved'),
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { tickets: Array<{ id: string }> };
    expect(listBody.tickets).toHaveLength(1);
  });
});
