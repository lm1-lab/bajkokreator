import { expect, test } from '@playwright/test';
import { fetchStoryViaApi } from './helpers';
import {
  advanceOrderToPreflightPassed,
  buildTestShippingAddress,
  createAgenticTracker,
  createExtendedStoryViaApi,
  createOrderViaApi,
  expectApiErrorEnvelope,
  expectRequestIdHeader,
  getOpsAuthHeaders,
  getTinyBlockingIllustrationPng,
  transitionOrderViaApi,
  uniqueIdempotencyKey,
  uploadIllustrationViaApi,
  type AgenticResourceTracker,
  type ExtendedStoryRecordDto,
  type OrderRecordDto,
  type PreflightReportDto,
} from './agentic-helpers';

test.describe('Tier 2 — Agentic Boundary, Validation & Guardrail Cases', () => {
  let activeTracker: AgenticResourceTracker | null = null;

  test.afterEach(async () => {
    if (activeTracker) {
      await activeTracker.cleanup();
      activeTracker = null;
    }
  });

  test('T2A-01: Catalog & prepress PDF invalid/boundary parameters (dates, upcomingDays, age, bleedMm, layoutMode, spineMm)', async ({
    page,
    request,
  }) => {
    activeTracker = createAgenticTracker(page, request);

    const story = await createExtendedStoryViaApi(request, {
      childName: 'OlekBnd',
      gender: 'boy',
      pageCount: 4,
      bookFormat: 'square',
      provider: 'demo',
    });
    activeTracker.trackStory(story.id);

    const invalidCatalogQueries: Array<{ url: string; code?: RegExp }> = [
      { url: '/api/catalog/themes?date=2026-02-30' },
      { url: '/api/catalog/themes?date=2026-02-31' },
      { url: '/api/catalog/themes?date=2026-04-31' },
      { url: '/api/catalog/themes?date=02-31' },
      { url: '/api/catalog/themes?upcomingDays=10abc' },
      { url: '/api/catalog/themes?upcomingDays=0' },
      { url: '/api/catalog/themes?upcomingDays=999' },
      { url: '/api/catalog/themes?upcomingDays=366' },
      { url: '/api/catalog/themes?age=0' },
      { url: '/api/catalog/themes?age=13' },
      { url: '/api/catalog/themes?age=5abc' },
    ];

    for (const probe of invalidCatalogQueries) {
      const res = await request.get(probe.url);
      await expectApiErrorEnvelope(res, {
        status: 400,
        code: probe.code,
      });
    }

    for (const badWindow of [
      { startMonthDay: '02-31', endMonthDay: '03-10' },
      { startMonthDay: '04-31', endMonthDay: '05-10' },
    ]) {
      const res = await request.post('/api/catalog/validate', {
        data: {
          theme: {
            id: `e2e-bad-date-${badWindow.startMonthDay}`,
            label: 'Nieprawidłowa Data Test',
            theme:
              'krótka testowa przygoda o magicznym kalendarzu w zaczarowanym ogrodzie',
            suggestedMood: 'warm-cozy',
            suggestedArtStyle: 'watercolor',
            season: 'spring',
            badge: 'Test',
            priority: 10,
            activeWindow: badWindow,
            tags: ['test'],
          },
        },
      });
      expectRequestIdHeader(res);
      expect([200, 400, 422]).toContain(res.status());
      const body = (await res.json()) as {
        valid?: boolean;
        errors?: unknown[];
        code?: string;
      };
      if (res.status() === 200) {
        expect(body.valid).toBe(false);
        expect(Array.isArray(body.errors) && body.errors.length >= 1).toBe(true);
      } else {
        expect(body.code).toBeTruthy();
      }
    }

    const basePdfUrl = `/api/stories/${encodeURIComponent(story.id)}/pdf`;
    const invalidPdfQueries = [
      `${basePdfUrl}?format=square&bleedMm=`,
      `${basePdfUrl}?format=square&bleedMm=%20`,
      `${basePdfUrl}?format=square&bleedMm=-1`,
      `${basePdfUrl}?format=square&bleedMm=11`,
      `${basePdfUrl}?format=square&layoutMode=booklet-invalid`,
      `${basePdfUrl}?format=square&layoutMode=cover-wrap&spineMm=-1`,
      `${basePdfUrl}?format=square&layoutMode=cover-wrap&spineMm=abc`,
      `${basePdfUrl}?format=square&layoutMode=cover-wrap&spineMm=`,
      `${basePdfUrl}?format=square&layoutMode=cover-wrap&spineMm=200`,
    ];

    for (const url of invalidPdfQueries) {
      const res = await request.get(url);
      await expectApiErrorEnvelope(res, { status: 400 });
    }

    const validBoundaryUrls = [
      '/api/catalog/themes?upcomingDays=1',
      '/api/catalog/themes?upcomingDays=365',
      '/api/catalog/themes?age=1',
      '/api/catalog/themes?age=12',
      `${basePdfUrl}?format=square&bleedMm=0`,
      `${basePdfUrl}?format=square&bleedMm=10`,
    ];

    for (const url of validBoundaryUrls) {
      const res = await request.get(url);
      expect(res.status(), `Expected valid boundary ${url} to return 200`).toBe(
        200,
      );
      expectRequestIdHeader(res);
    }
  });

  test('T2A-02: Order guardrails (idempotency replay, 403 actor allowlists & refund cap, 409 preconditions & version conflict)', async ({
    page,
    request,
  }) => {
    activeTracker = createAgenticTracker(page, request);

    const story = await createExtendedStoryViaApi(request, {
      childName: 'TymonOrd',
      gender: 'boy',
      pageCount: 4,
      bookFormat: 'square',
      provider: 'demo',
    });
    activeTracker.trackStory(story.id);

    // Case A: Idempotent POST /api/orders replay
    const idemKey = uniqueIdempotencyKey('e2e-idem-t2');
    const created = await createOrderViaApi(request, {
      storyId: story.id,
      bookFormat: 'square',
      quantity: 1,
      totalMinorUnits: 12900,
      shippingAddress: buildTestShippingAddress({
        email: 'idem-t2@example.com',
      }),
      idempotencyKey: idemKey,
    });
    activeTracker.trackOrder(created.order.id);
    expect(created.status).toBe(201);

    const replayed = await createOrderViaApi(request, {
      storyId: story.id,
      bookFormat: 'square',
      quantity: 1,
      totalMinorUnits: 12900,
      shippingAddress: buildTestShippingAddress({
        email: 'idem-t2@example.com',
      }),
      idempotencyKey: idemKey,
    });
    expect(replayed.status).toBe(200);
    expect(replayed.order.id).toBe(created.order.id);
    expect(replayed.order.orderNumber).toBe(created.order.orderNumber);
    expect(replayed.order.createdAt).toBe(created.order.createdAt);

    const listAfterReplayRes = await request.get(
      `/api/orders?storyId=${encodeURIComponent(story.id)}`,
      { headers: getOpsAuthHeaders() },
    );
    expect(listAfterReplayRes.status()).toBe(200);
    const listAfterReplay = (await listAfterReplayRes.json()) as {
      orders: OrderRecordDto[];
    };
    const matchingOrders = listAfterReplay.orders.filter(
      (o) => o.id === created.order.id,
    );
    expect(matchingOrders).toHaveLength(1);

    // Case B: Agent & non-allowlisted actors blocked from paid & approved_for_print (403)
    const toPending = await transitionOrderViaApi(request, created.order.id, {
      nextStatus: 'awaiting_payment',
      actor: { kind: 'customer', id: 'cust-b' },
    });
    expect(toPending.status()).toBe(200);

    const agentPaidRes = await transitionOrderViaApi(request, created.order.id, {
      nextStatus: 'paid',
      actor: { kind: 'agent', id: 'agent-b' },
      patch: { paymentReference: 'pay_forged' },
    });
    await expectApiErrorEnvelope(agentPaidRes, { status: 403 });

    const customerPaidRes = await transitionOrderViaApi(
      request,
      created.order.id,
      {
        nextStatus: 'paid',
        actor: { kind: 'customer', id: 'cust-b' },
        patch: { paymentReference: 'pay_forged_cust' },
      },
    );
    await expectApiErrorEnvelope(customerPaidRes, { status: 403 });

    const legitPaid = await transitionOrderViaApi(request, created.order.id, {
      nextStatus: 'paid',
      actor: { kind: 'payment-webhook', id: 'wh-b' },
      patch: { paymentReference: 'pay_b_001' },
    });
    expect(legitPaid.status()).toBe(200);

    const agentApproveRes = await transitionOrderViaApi(
      request,
      created.order.id,
      {
        nextStatus: 'approved_for_print',
        actor: { kind: 'agent', id: 'agent-b' },
      },
    );
    await expectApiErrorEnvelope(agentApproveRes, { status: 403 });

    const systemApproveRes = await transitionOrderViaApi(
      request,
      created.order.id,
      {
        nextStatus: 'approved_for_print',
        actor: { kind: 'system', id: 'sys-b' },
      },
    );
    await expectApiErrorEnvelope(systemApproveRes, { status: 403 });

    // Case C: submitted_to_printer blocked without approval / preflight / shippingAddress (409)
    const submitBeforeApprove = await transitionOrderViaApi(
      request,
      created.order.id,
      {
        nextStatus: 'submitted_to_printer',
        actor: { kind: 'system', id: 'fulfillment-bot' },
      },
    );
    await expectApiErrorEnvelope(submitBeforeApprove, { status: 409 });

    const approveRes = await request.post(
      `/api/orders/${encodeURIComponent(created.order.id)}/approve`,
      {
        headers: getOpsAuthHeaders(),
        data: { actor: { kind: 'customer', id: 'cust-b' } },
      },
    );
    expect(approveRes.status()).toBe(200);

    const submitBeforePreflight = await transitionOrderViaApi(
      request,
      created.order.id,
      {
        nextStatus: 'submitted_to_printer',
        actor: { kind: 'system', id: 'fulfillment-bot' },
      },
    );
    await expectApiErrorEnvelope(submitBeforePreflight, { status: 409 });

    const noAddrCreated = await createOrderViaApi(request, {
      storyId: story.id,
      bookFormat: 'square',
      quantity: 1,
      totalMinorUnits: 12900,
      idempotencyKey: uniqueIdempotencyKey('e2e-noaddr-t2'),
    });
    activeTracker.trackOrder(noAddrCreated.order.id);
    await advanceOrderToPreflightPassed(request, noAddrCreated.order.id);

    const submitNoAddrRes = await transitionOrderViaApi(
      request,
      noAddrCreated.order.id,
      {
        nextStatus: 'submitted_to_printer',
        actor: { kind: 'system', id: 'fulfillment-bot' },
      },
    );
    await expectApiErrorEnvelope(submitNoAddrRes, { status: 409 });

    // Case D: Refund cap (> 0 gr) blocks agent & customer (403); admin succeeds (200)
    const agentRefundRes = await request.post(
      `/api/orders/${encodeURIComponent(created.order.id)}/refund`,
      {
        headers: getOpsAuthHeaders(),
        data: {
          actor: { kind: 'agent', id: 'support-agent' },
          reason: 'Próba zwrotu przez agenta',
        },
      },
    );
    await expectApiErrorEnvelope(agentRefundRes, { status: 403 });

    const customerRefundRes = await request.post(
      `/api/orders/${encodeURIComponent(created.order.id)}/refund`,
      {
        headers: getOpsAuthHeaders(),
        data: {
          actor: { kind: 'customer', id: 'cust-b' },
          reason: 'Próba zwrotu przez klienta',
        },
      },
    );
    await expectApiErrorEnvelope(customerRefundRes, { status: 403 });

    const adminRefundRes = await request.post(
      `/api/orders/${encodeURIComponent(created.order.id)}/refund`,
      {
        headers: getOpsAuthHeaders(),
        data: {
          actor: { kind: 'admin', id: 'owner-admin' },
          reason: 'Zwrot testowy zatwierdzony przez administratora',
        },
      },
    );
    expect(adminRefundRes.status()).toBe(200);
    const refundedBody = (await adminRefundRes.json()) as {
      order: OrderRecordDto;
    };
    expect(refundedBody.order.status).toBe('refunded');
    expect(refundedBody.order.paymentStatus).toBe('refunded');

    // Case E: Optimistic concurrency version conflict (409)
    const verOrder = await createOrderViaApi(request, {
      storyId: story.id,
      shippingAddress: buildTestShippingAddress({ email: 'ver-t2@example.com' }),
      idempotencyKey: uniqueIdempotencyKey('e2e-ver-t2'),
    });
    activeTracker.trackOrder(verOrder.order.id);
    expect(verOrder.order.version).toBe(1);

    const v1To2 = await transitionOrderViaApi(request, verOrder.order.id, {
      nextStatus: 'awaiting_payment',
      actor: { kind: 'customer', id: 'cust-ver' },
      expectedVersion: 1,
    });
    expect(v1To2.status()).toBe(200);
    const v2Order = ((await v1To2.json()) as { order: OrderRecordDto }).order;
    expect(v2Order.version).toBe(2);

    const staleVersionRes = await transitionOrderViaApi(
      request,
      verOrder.order.id,
      {
        nextStatus: 'cancelled',
        actor: { kind: 'customer', id: 'cust-ver' },
        expectedVersion: 1,
      },
    );
    await expectApiErrorEnvelope(staleVersionRes, { status: 409 });

    const verCheckRes = await request.get(
      `/api/orders/${encodeURIComponent(verOrder.order.id)}`,
      { headers: getOpsAuthHeaders() },
    );
    expect(verCheckRes.status()).toBe(200);
    const verCheck = ((await verCheckRes.json()) as { order: OrderRecordDto })
      .order;
    expect(verCheck.status).toBe('awaiting_payment');
    expect(verCheck.version).toBe(2);
  });

  test('T2A-03: Customer support security — indistinguishable 404 without PII leak & mandatory escalation + PII redaction', async ({
    page,
    request,
  }) => {
    activeTracker = createAgenticTracker(page, request);

    const story = await createExtendedStoryViaApi(request, {
      childName: 'LenaSec',
      pageCount: 4,
      provider: 'demo',
    });
    activeTracker.trackStory(story.id);

    const { order } = await createOrderViaApi(request, {
      storyId: story.id,
      shippingAddress: buildTestShippingAddress({
        recipientName: 'Katarzyna Tajna',
        line1: 'ul. Ukryta 99',
        postalCode: '50-123',
        city: 'Wrocław',
        email: 'katarzyna.tajna@example.com',
      }),
      idempotencyKey: uniqueIdempotencyKey('e2e-sec-t2'),
    });
    activeTracker.trackOrder(order.id);

    const negativeLookups = [
      { orderNumber: order.orderNumber, verification: 'wrong@example.com' },
      { orderNumber: order.orderNumber, verification: '00-000' },
      {
        orderNumber: 'BK-2099-ZZZZZZ',
        verification: 'katarzyna.tajna@example.com',
      },
    ];

    const codes: string[] = [];
    for (const payload of negativeLookups) {
      const res = await request.post('/api/support/order-status', {
        data: payload,
      });
      const envelope = await expectApiErrorEnvelope(res, { status: 404 });
      codes.push(envelope.code);

      const serialized = JSON.stringify(envelope);
      for (const secret of [
        'Katarzyna',
        'Tajna',
        'Ukryta',
        '50-123',
        'Wrocław',
        'katarzyna.tajna@example.com',
        order.id,
      ]) {
        expect(
          serialized,
          `404 response must never leak "${secret}"`,
        ).not.toContain(secret);
      }
    }
    expect(codes[0]).toBe(codes[1]);
    expect(codes[1]).toBe(codes[2]);

    const escalationProbes = [
      {
        label: 'refund + PII',
        subject: 'Zwrot środków',
        message:
          'Żądam zwrotu 129 zł za zamówienie. Kontakt: +48 600 987 654, jan.kowalski@example.com, PESEL 92030456789.',
        checkPiiRedaction: true,
      },
      {
        label: 'RODO data subject',
        subject: 'Wniosek RODO',
        message:
          'Proszę o natychmiastowe usunięcie wszystkich moich danych osobowych i zdjęć dziecka na podstawie RODO.',
        checkPiiRedaction: false,
      },
      {
        label: 'damaged book',
        subject: 'Reklamacja uszkodzonej książki',
        message:
          'Książka dotarła uszkodzona, grzbiet jest rozklejony a druk rozmazany. Składam reklamację.',
        checkPiiRedaction: false,
      },
      {
        label: 'chargeback / legal threat',
        subject: 'Spór bankowy',
        message: 'Zgłoszę sprawę do UOKiK i zlecę chargeback w banku.',
        checkPiiRedaction: false,
      },
    ];

    for (const probe of escalationProbes) {
      const res = await request.post('/api/support/inquiries', {
        data: {
          customerEmail: 'eskalacja-t2@example.com',
          orderNumber: order.orderNumber,
          subject: probe.subject,
          message: probe.message,
        },
      });
      expect(
        [200, 201],
        `Inquiry (${probe.label}) returned ${res.status()}: ${await res.text()}`,
      ).toContain(res.status());
      expectRequestIdHeader(res);

      const body = (await res.json()) as {
        ticket: { id: string } & Record<string, unknown>;
        escalation: { shouldEscalate: boolean; reasons: string[] };
      };
      expect(
        body.escalation.shouldEscalate,
        `Expected mandatory escalation for ${probe.label}`,
      ).toBe(true);
      expect(body.escalation.reasons.length).toBeGreaterThanOrEqual(1);

      if (probe.checkPiiRedaction) {
        const createdTicketStr = JSON.stringify(body.ticket);
        expect(createdTicketStr).not.toContain('92030456789');
        expect(createdTicketStr).not.toContain('600 987 654');

        const fetchedRes = await request.get(
          `/api/support/inquiries/${encodeURIComponent(body.ticket.id)}`,
          { headers: getOpsAuthHeaders() },
        );
        expect(fetchedRes.status()).toBe(200);
        expectRequestIdHeader(fetchedRes);
        const fetchedStr = await fetchedRes.text();
        expect(fetchedStr).not.toContain('92030456789');
        expect(fetchedStr).not.toContain('600 987 654');
      }
    }
  });

  test('T2A-04: Non-multipart /illustrations/[slot] returns 400 (not 500) & repeat RODO purge preserves original referencePhotosPurgedAt', async ({
    page,
    request,
  }) => {
    activeTracker = createAgenticTracker(page, request);

    const story = await createExtendedStoryViaApi(request, {
      childName: 'NadiaMp',
      pageCount: 4,
      provider: 'demo',
    });
    activeTracker.trackStory(story.id);

    const jsonArtRes = await request.post(
      `/api/stories/${encodeURIComponent(story.id)}/illustrations/cover`,
      {
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ file: 'fake' }),
      },
    );
    await expectApiErrorEnvelope(jsonArtRes, { status: 400 });

    const textArtRes = await request.post(
      `/api/stories/${encodeURIComponent(story.id)}/illustrations/1`,
      {
        headers: { 'Content-Type': 'text/plain' },
        data: 'not multipart payload',
      },
    );
    await expectApiErrorEnvelope(textArtRes, { status: 400 });

    const untouchedStory = await fetchStoryViaApi(request, story.id);
    expect(untouchedStory.coverStatus).toBe('ready');

    const firstPurgeRes = await request.delete(
      `/api/stories/${encodeURIComponent(story.id)}/reference-photos`,
    );
    expect(firstPurgeRes.status()).toBe(200);
    expectRequestIdHeader(firstPurgeRes);
    const firstPurge = (await firstPurgeRes.json()) as {
      purged: boolean;
      deletedFiles: string[];
      purgedAt: string;
    };
    expect(firstPurge.purged).toBe(true);
    expect(firstPurge.deletedFiles).toHaveLength(1);

    const storyAfterFirst = (await fetchStoryViaApi(
      request,
      story.id,
    )) as ExtendedStoryRecordDto;
    expect(storyAfterFirst.referencePhotosPurgedAt).toBe(firstPurge.purgedAt);

    await new Promise((resolve) => setTimeout(resolve, 50));

    const secondPurgeRes = await request.delete(
      `/api/stories/${encodeURIComponent(story.id)}/reference-photos`,
    );
    expect(secondPurgeRes.status()).toBe(200);
    const secondPurge = (await secondPurgeRes.json()) as {
      purged: boolean;
      deletedFiles: string[];
      purgedAt: string;
    };
    expect(secondPurge.purged).toBe(true);
    expect(secondPurge.deletedFiles).toEqual([]);
    expect(secondPurge.purgedAt).toBe(firstPurge.purgedAt);

    const storyAfterSecond = (await fetchStoryViaApi(
      request,
      story.id,
    )) as ExtendedStoryRecordDto;
    expect(storyAfterSecond.referencePhotosPurgedAt).toBe(firstPurge.purgedAt);
    expect(storyAfterSecond.updatedAt).toBe(storyAfterFirst.updatedAt);

    const missingPurgeRes = await request.delete(
      '/api/stories/nonexistent-rodo-0001/reference-photos',
    );
    await expectApiErrorEnvelope(missingPurgeRes, {
      status: 404,
      code: 'NOT_FOUND',
    });
  });

  test('T2A-05: Preflight blockers & warnings (incomplete preview, short text, placeholder, overflow, low-DPI blocking, bad format/404)', async ({
    page,
    request,
  }) => {
    activeTracker = createAgenticTracker(page, request);

    const previewStory = await createExtendedStoryViaApi(request, {
      childName: 'IgaPrev',
      pageCount: 6,
      provider: 'demo',
      generationMode: 'preview-first',
    });
    activeTracker.trackStory(previewStory.id);

    const previewPreflightRes = await request.get(
      `/api/stories/${encodeURIComponent(previewStory.id)}/preflight?format=square`,
    );
    expect(previewPreflightRes.status()).toBe(200);
    const { report: previewReport } = (await previewPreflightRes.json()) as {
      report: PreflightReportDto;
    };
    expect(previewReport.readyForPrint).toBe(false);
    expect(previewReport.summary.errors).toBeGreaterThanOrEqual(1);
    expect(
      previewReport.issues.some(
        (i) => i.code === 'STORY_INCOMPLETE_STAGE' && i.severity === 'error',
      ),
    ).toBe(true);
    expect(
      previewReport.issues.some(
        (i) => i.code === 'MISSING_ARTWORK' && i.severity === 'error',
      ),
    ).toBe(true);

    const brokenStory = await createExtendedStoryViaApi(request, {
      childName: 'JacekErr',
      gender: 'boy',
      pageCount: 4,
      bookFormat: 'square',
      provider: 'demo',
    });
    activeTracker.trackStory(brokenStory.id);

    const p1Res = await request.patch(
      `/api/stories/${encodeURIComponent(brokenStory.id)}/pages/1`,
      { data: { text: 'Za krótkie.' } },
    );
    expect(p1Res.status()).toBe(200);

    const p2Res = await request.patch(
      `/api/stories/${encodeURIComponent(brokenStory.id)}/pages/2`,
      {
        data: {
          text: 'Witaj {{childName}}, tutaj został tekst TODO do poprawy przed drukiem.',
        },
      },
    );
    expect(p2Res.status()).toBe(200);

    const longText =
      'Bardzo długa opowieść o przygodach małego odkrywcy w zaczarowanym lesie świetlików. '.repeat(
        14,
      );
    const p3Res = await request.patch(
      `/api/stories/${encodeURIComponent(brokenStory.id)}/pages/3`,
      { data: { text: longText } },
    );
    expect(p3Res.status()).toBe(200);

    await uploadIllustrationViaApi(
      request,
      brokenStory.id,
      'cover',
      await getTinyBlockingIllustrationPng(),
    );

    const brokenPreflightRes = await request.get(
      `/api/stories/${encodeURIComponent(brokenStory.id)}/preflight?format=square`,
    );
    expect(brokenPreflightRes.status()).toBe(200);
    const { report: brokenReport } = (await brokenPreflightRes.json()) as {
      report: PreflightReportDto;
    };
    expect(brokenReport.readyForPrint).toBe(false);
    expect(brokenReport.summary.errors).toBeGreaterThanOrEqual(2);

    expect(
      brokenReport.issues.some(
        (i) =>
          i.code === 'TEXT_TOO_SHORT' &&
          i.severity === 'warning' &&
          i.slot === 1,
      ),
    ).toBe(true);
    expect(
      brokenReport.issues.some(
        (i) =>
          i.code === 'UNRESOLVED_PLACEHOLDER' &&
          i.severity === 'error' &&
          i.slot === 2,
      ),
    ).toBe(true);
    expect(
      brokenReport.issues.some(
        (i) =>
          i.code === 'TEXT_OVERFLOW_RISK' &&
          i.severity === 'warning' &&
          i.slot === 3,
      ),
    ).toBe(true);
    expect(
      brokenReport.issues.some(
        (i) =>
          i.code === 'LOW_IMAGE_RESOLUTION_BLOCKING' &&
          i.severity === 'error' &&
          i.slot === 'cover',
      ),
    ).toBe(true);

    const badFmtRes = await request.get(
      `/api/stories/${encodeURIComponent(brokenStory.id)}/preflight?format=invalid-fmt`,
    );
    await expectApiErrorEnvelope(badFmtRes, {
      status: 400,
      code: 'INVALID_BOOK_FORMAT',
    });

    const missingStoryRes = await request.get(
      '/api/stories/missing-preflight-999/preflight',
    );
    await expectApiErrorEnvelope(missingStoryRes, {
      status: 404,
      code: 'NOT_FOUND',
    });
  });

  test('T2A-06: Stale-preflight revision pinning invalidates manifest & print submission after story edit (409) and transitions to preflight_failed', async ({
    page,
    request,
  }) => {
    activeTracker = createAgenticTracker(page, request);

    const story = await createExtendedStoryViaApi(request, {
      childName: 'KubaPin',
      gender: 'boy',
      pageCount: 4,
      bookFormat: 'square',
      provider: 'demo',
    });
    activeTracker.trackStory(story.id);

    const { order } = await createOrderViaApi(request, {
      storyId: story.id,
      bookFormat: 'square',
      shippingAddress: buildTestShippingAddress({ email: 'pin-t2@example.com' }),
      idempotencyKey: uniqueIdempotencyKey('e2e-pin-t2'),
    });
    activeTracker.trackOrder(order.id);

    const preflighted = await advanceOrderToPreflightPassed(request, order.id);
    expect(preflighted.order.preflightStoryUpdatedAt).toBe(story.updatedAt);

    await new Promise((resolve) => setTimeout(resolve, 25));

    const mutateRes = await request.patch(
      `/api/stories/${encodeURIComponent(story.id)}/pages/1`,
      {
        data: {
          text: 'Zmieniona treść z błędem {{placeholder}} po wykonaniu preflightu.',
        },
      },
    );
    expect(mutateRes.status()).toBe(200);

    const staleManifestRes = await request.get(
      `/api/orders/${encodeURIComponent(order.id)}/print-manifest`,
      { headers: getOpsAuthHeaders() },
    );
    await expectApiErrorEnvelope(staleManifestRes, { status: 409 });

    const staleSubmitRes = await transitionOrderViaApi(request, order.id, {
      nextStatus: 'submitted_to_printer',
      actor: { kind: 'system', id: 'fulfillment-bot' },
    });
    await expectApiErrorEnvelope(staleSubmitRes, { status: 409 });

    const recheckRes = await request.post(
      `/api/orders/${encodeURIComponent(order.id)}/preflight`,
      { headers: getOpsAuthHeaders() },
    );
    expect(recheckRes.status()).toBe(200);
    const recheckBody = (await recheckRes.json()) as {
      order: OrderRecordDto;
      preflight: PreflightReportDto;
    };
    expect(recheckBody.preflight.readyForPrint).toBe(false);
    expect(recheckBody.order.status).toBe('preflight_failed');
  });
});
