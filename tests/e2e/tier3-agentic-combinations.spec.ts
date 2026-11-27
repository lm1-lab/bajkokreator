import { expect, test } from '@playwright/test';
import {
  attachErrorGuards,
  expectAllVisibleImagesLoaded,
  expectLoadedImage,
  fetchStoryViaApi,
  fillCreatorFormAndSubmit,
} from './helpers';
import {
  ORDER_NUMBER_RE,
  advanceOrderToPreflightPassed,
  buildTestShippingAddress,
  createAgenticTracker,
  createExtendedStoryViaApi,
  createOrderViaApi,
  expectApiErrorEnvelope,
  expectRequestIdHeader,
  getOpsAuthHeaders,
  getPrintReadyIllustrationPng,
  getPrintReadyIllustrationWebp,
  lookupOrderStatusViaUi,
  openPreflightPanel,
  purgeReferencePhotosViaUi,
  runRetentionSweepViaApi,
  selectSeasonalThemeChip,
  transitionOrderViaApi,
  triggerPrintReadyPdfDownload,
  uniqueIdempotencyKey,
  uploadIllustrationViaApi,
  type AgenticResourceTracker,
  type ExtendedStoryRecordDto,
  type PreflightReportDto,
  type PrintJobManifestDto,
} from './agentic-helpers';

test.describe('Tier 3 — Agentic Cross-Feature Pairwise Combinations', () => {
  let activeTracker: AgenticResourceTracker | null = null;

  test.afterEach(async () => {
    if (activeTracker) {
      await activeTracker.cleanup();
      activeTracker = null;
    }
  });

  test('T3A-01: Seasonal theme selection -> story creation -> preflight -> print-ready 16-page bleed+crop PDF & Polish Genitive', async ({
    page,
    request,
  }) => {
    const guard = attachErrorGuards(page);
    activeTracker = createAgenticTracker(page, request);

    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const toggleBtn = page.getByTestId('toggle-all-themes-btn');
    await expect(toggleBtn).toBeVisible();
    const initialChipCount = await page.getByTestId('inspiration-chip').count();
    await toggleBtn.click();
    const expandedChipCount = await page.getByTestId('inspiration-chip').count();
    expect(expandedChipCount).toBeGreaterThan(initialChipCount);

    const selected = await selectSeasonalThemeChip(page);
    expect(selected.season).not.toBe('evergreen');
    expect(selected.themeValue.length).toBeGreaterThan(5);

    const { storyId } = await fillCreatorFormAndSubmit(page, {
      childName: 'Zosia',
      childAge: 5,
      gender: 'girl',
      companion: 'rudy kotek Mruczek',
      pageCount: 10,
      provider: 'demo',
    });
    activeTracker.trackStory(storyId);

    const preflightRes = await request.get(
      `/api/stories/${encodeURIComponent(storyId)}/preflight?format=square`,
    );
    expect(preflightRes.status()).toBe(200);
    expectRequestIdHeader(preflightRes);
    const { report } = (await preflightRes.json()) as {
      report: PreflightReportDto;
    };
    expect(report.readyForPrint).toBe(true);
    expect(report.metrics.totalPdfPages).toBe(13);
    expect(report.metrics.paddingNeededForMultipleOf4).toBe(3);
    expect(
      report.issues.some(
        (issue) =>
          issue.code === 'PAGE_COUNT_PADDING_RECOMMENDED' &&
          issue.severity === 'info',
      ),
    ).toBe(true);

    const verifiedPdf = await triggerPrintReadyPdfDownload(page, 'square', {
      bleedMm: 3,
      cropMarks: true,
      padToMultipleOf4: true,
      expectedPageCount: 16,
      expectedTextSnippets: ['Zosi', 'NOTATKI I RYSUNKI'],
      forbiddenTextSnippets: ['Dla Zosia', 'dla Zosia'],
    });
    expect(verifiedPdf.extractedText?.toLowerCase()).toContain('dla zosi');
    expect(verifiedPdf.firstPageBoxes.mediaBox.width).toBeGreaterThan(
      verifiedPdf.firstPageBoxes.bleedBox.width,
    );
    expect(verifiedPdf.firstPageBoxes.bleedBox.width).toBeGreaterThan(
      verifiedPdf.firstPageBoxes.trimBox.width,
    );

    guard.assertClean();
  });

  test('T3A-02: Preview-first RODO purge guard on /continue vs complete story UI RODO purge -> monogram fallback + preflight re-check', async ({
    page,
    request,
  }) => {
    const guard = attachErrorGuards(page);
    activeTracker = createAgenticTracker(page, request);

    // Part A: Preview-first story RODO purge guard
    const previewStory = await createExtendedStoryViaApi(request, {
      childName: 'IgaGuard',
      pageCount: 6,
      provider: 'demo',
      generationMode: 'preview-first',
    });
    activeTracker.trackStory(previewStory.id);
    expect(previewStory.generationStage).toBe('preview');

    const previewPurgeRes = await request.delete(
      `/api/stories/${encodeURIComponent(previewStory.id)}/reference-photos`,
    );
    if (previewPurgeRes.status() === 409) {
      await expectApiErrorEnvelope(previewPurgeRes, { status: 409 });
    } else {
      expect(previewPurgeRes.status()).toBe(200);
      expectRequestIdHeader(previewPurgeRes);
      const continueAfterPurgeRes = await request.post(
        `/api/stories/${encodeURIComponent(previewStory.id)}/continue`,
      );
      await expectApiErrorEnvelope(continueAfterPurgeRes, {
        status: [400, 409],
      });
      const stillPreview = await fetchStoryViaApi(request, previewStory.id);
      expect(stillPreview.generationStage).toBe('preview');
    }

    // Part B: Complete story UI RODO purge -> monogram fallback + preflight re-check
    const completeStory = await createExtendedStoryViaApi(request, {
      childName: 'HaniaMono',
      pageCount: 6,
      provider: 'demo',
      generationMode: 'full',
    });
    activeTracker.trackStory(completeStory.id);
    const firstRef = completeStory.referencePhotos[0];
    expect(firstRef).toBeTruthy();

    await page.goto(`/story/${encodeURIComponent(completeStory.id)}?slide=1`, {
      waitUntil: 'domcontentloaded',
    });
    await expectLoadedImage(page.getByTestId('dedication-photo'));

    const purgeData = await purgeReferencePhotosViaUi(page, completeStory.id);
    expect(purgeData.purged).toBe(true);

    const purgedAssetRes = await request.get(
      `/api/stories/${encodeURIComponent(completeStory.id)}/assets/${encodeURIComponent(firstRef)}`,
    );
    await expectApiErrorEnvelope(purgedAssetRes, { status: 404 });

    const replayPurgeRes = await request.delete(
      `/api/stories/${encodeURIComponent(completeStory.id)}/reference-photos`,
    );
    expect(replayPurgeRes.status()).toBe(200);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('dedication-photo')).toHaveCount(0);
    await expectAllVisibleImagesLoaded(page);

    const preflightRes = await request.get(
      `/api/stories/${encodeURIComponent(completeStory.id)}/preflight?format=square`,
    );
    expect(preflightRes.status()).toBe(200);
    const { report } = (await preflightRes.json()) as {
      report: PreflightReportDto;
    };
    expect(report.readyForPrint).toBe(true);
    expect(
      report.issues.some(
        (i) => i.code === 'DEDICATION_PHOTO_ABSENT' && i.severity === 'info',
      ),
    ).toBe(true);

    await openPreflightPanel(page);
    await expect(page.getByTestId('preflight-badge')).toBeVisible();

    guard.assertClean();
  });

  test('T3A-03: Complete story -> idempotent order -> guardrails -> print manifest (SHA-256) -> /orders & support lookup -> active-order RODO retention lock', async ({
    page,
    request,
  }) => {
    const guard = attachErrorGuards(page);
    activeTracker = createAgenticTracker(page, request);

    const lockedStory = await createExtendedStoryViaApi(request, {
      childName: 'LeonLock',
      gender: 'boy',
      pageCount: 6,
      bookFormat: 'square',
      provider: 'demo',
    });
    activeTracker.trackStory(lockedStory.id);

    const unlockedStory = await createExtendedStoryViaApi(request, {
      childName: 'MajaFree',
      gender: 'girl',
      pageCount: 6,
      bookFormat: 'square',
      provider: 'demo',
    });
    activeTracker.trackStory(unlockedStory.id);

    const idemKey = uniqueIdempotencyKey('e2e-t3-lock');
    const shippingAddress = buildTestShippingAddress({
      recipientName: 'Tomasz Leonowicz',
      line1: 'ul. Bajkowa 7/2',
      postalCode: '00-001',
      city: 'Warszawa',
      email: 'rodzic.leon@example.pl',
    });

    const firstOrder = await createOrderViaApi(request, {
      storyId: lockedStory.id,
      bookFormat: 'square',
      quantity: 1,
      totalMinorUnits: 12900,
      shippingAddress,
      idempotencyKey: idemKey,
    });
    activeTracker.trackOrder(firstOrder.order.id);
    expect(firstOrder.status).toBe(201);
    expect(firstOrder.order.orderNumber).toMatch(ORDER_NUMBER_RE);
    expect(firstOrder.order.version).toBe(1);

    const replayOrder = await createOrderViaApi(request, {
      storyId: lockedStory.id,
      bookFormat: 'square',
      quantity: 1,
      totalMinorUnits: 12900,
      shippingAddress,
      idempotencyKey: idemKey,
    });
    expect(replayOrder.status).toBe(200);
    expect(replayOrder.order.id).toBe(firstOrder.order.id);
    expect(replayOrder.order.orderNumber).toBe(firstOrder.order.orderNumber);

    const agentForbiddenRes = await transitionOrderViaApi(
      request,
      firstOrder.order.id,
      {
        nextStatus: 'paid',
        actor: { kind: 'agent', id: 'bot-1' },
      },
    );
    await expectApiErrorEnvelope(agentForbiddenRes, { status: 403 });

    await advanceOrderToPreflightPassed(request, firstOrder.order.id);

    const manifestRes = await request.get(
      `/api/orders/${encodeURIComponent(firstOrder.order.id)}/print-manifest`,
      { headers: getOpsAuthHeaders() },
    );
    expect(manifestRes.status()).toBe(200);
    expectRequestIdHeader(manifestRes);
    const { manifest } = (await manifestRes.json()) as {
      manifest: PrintJobManifestDto;
    };
    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.orderId).toBe(firstOrder.order.id);
    expect(manifest.pdfSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.pdfBytesLength).toBeGreaterThan(20_480);
    expect(manifest.pdfSpec.bleedMm).toBeGreaterThanOrEqual(3);
    expect(manifest.pdfSpec.totalPdfPages % 4).toBe(0);

    const supportLookupRes = await request.post('/api/support/order-status', {
      data: {
        orderNumber: firstOrder.order.orderNumber,
        verification: 'rodzic.leon@example.pl',
      },
    });
    expect(supportLookupRes.status()).toBe(200);
    const supportLookup = (await supportLookupRes.json()) as {
      found: boolean;
      statusView: Record<string, unknown>;
    };
    expect(supportLookup.found).toBe(true);
    const statusViewJson = JSON.stringify(supportLookup.statusView);
    expect(statusViewJson).toContain(firstOrder.order.orderNumber);
    expect(statusViewJson).not.toContain('ul. Bajkowa 7/2');
    expect(statusViewJson).not.toContain('bot-1');
    expect(statusViewJson).not.toContain('payment-webhook');

    await page.goto('/orders', { waitUntil: 'domcontentloaded' });
    await lookupOrderStatusViaUi(
      page,
      firstOrder.order.orderNumber,
      'rodzic.leon@example.pl',
      { expectedStatus: 200 },
    );
    await expect(page.getByTestId('order-status-card')).toContainText(
      firstOrder.order.orderNumber,
    );

    const drySweep = await runRetentionSweepViaApi(request, { dryRun: true });
    expect(drySweep.body.dryRun).toBe(true);
    const unlockedAfterDry = (await fetchStoryViaApi(
      request,
      unlockedStory.id,
    )) as ExtendedStoryRecordDto;
    expect(unlockedAfterDry.referencePhotos.length).toBeGreaterThanOrEqual(1);

    const execSweep = await runRetentionSweepViaApi(request, { dryRun: false });
    expect(execSweep.body.dryRun).toBe(false);

    const lockedAfterSweep = (await fetchStoryViaApi(
      request,
      lockedStory.id,
    )) as ExtendedStoryRecordDto;
    expect(
      lockedAfterSweep.referencePhotos.length,
      'Active order lock must protect lockedStory reference photos from retention sweep',
    ).toBeGreaterThanOrEqual(1);
    expect(lockedAfterSweep.referencePhotosPurgedAt).toBeUndefined();

    const unlockedAfterSweep = (await fetchStoryViaApi(
      request,
      unlockedStory.id,
    )) as ExtendedStoryRecordDto;
    expect(
      unlockedAfterSweep.referencePhotos,
      'Unlocked complete story reference photos must be purged by retention sweep',
    ).toEqual([]);
    expect(unlockedAfterSweep.referencePhotosPurgedAt).toBeTruthy();

    guard.assertClean();
  });

  test('T3A-04: Manual-mode 4-page story -> print-grade PNG + WebP uploads -> generationStage complete -> preflight pass -> 8-page print-ready PDF', async ({
    page,
    request,
  }) => {
    const guard = attachErrorGuards(page);
    activeTracker = createAgenticTracker(page, request);

    const story = await createExtendedStoryViaApi(request, {
      childName: 'Klara',
      childAge: 6,
      gender: 'girl',
      pageCount: 4,
      bookFormat: 'square',
      provider: 'manual',
    });
    activeTracker.trackStory(story.id);
    expect(story.generationStage).toBe('awaiting-manual-art');

    const beforePreflightRes = await request.get(
      `/api/stories/${encodeURIComponent(story.id)}/preflight?format=square`,
    );
    expect(beforePreflightRes.status()).toBe(200);
    const { report: beforeReport } = (await beforePreflightRes.json()) as {
      report: PreflightReportDto;
    };
    expect(beforeReport.readyForPrint).toBe(false);
    const beforeCodes = beforeReport.issues.map((i) => i.code);
    expect(beforeCodes).toContain('STORY_INCOMPLETE_STAGE');
    expect(beforeCodes).toContain('MISSING_ARTWORK');

    const coverPng = await getPrintReadyIllustrationPng('cover');
    const pagePng = await getPrintReadyIllustrationPng('page');
    const pageWebp = await getPrintReadyIllustrationWebp();

    await uploadIllustrationViaApi(request, story.id, 'cover', coverPng);
    await uploadIllustrationViaApi(request, story.id, 1, pagePng);
    await uploadIllustrationViaApi(request, story.id, 2, pageWebp);
    await uploadIllustrationViaApi(request, story.id, 3, pagePng);
    await uploadIllustrationViaApi(request, story.id, 4, pagePng);

    const completedStory = await fetchStoryViaApi(request, story.id);
    expect(completedStory.generationStage).toBe('complete');

    const afterPreflightRes = await request.get(
      `/api/stories/${encodeURIComponent(story.id)}/preflight?format=square`,
    );
    expect(afterPreflightRes.status()).toBe(200);
    const { report: afterReport } = (await afterPreflightRes.json()) as {
      report: PreflightReportDto;
    };
    expect(afterReport.readyForPrint).toBe(true);
    expect(afterReport.summary.errors).toBe(0);
    expect(afterReport.metrics.readyArtworkSlots).toBe(5);
    expect(afterReport.metrics.minEffectiveDpi ?? 0).toBeGreaterThanOrEqual(
      200,
    );

    await page.goto(`/story/${encodeURIComponent(story.id)}?slide=0`, {
      waitUntil: 'domcontentloaded',
    });
    await openPreflightPanel(page);

    const pdf = await triggerPrintReadyPdfDownload(page, 'square', {
      bleedMm: 3,
      cropMarks: true,
      padToMultipleOf4: true,
      expectedPageCount: 8,
      expectedTextSnippets: ['Klary'],
      forbiddenTextSnippets: ['Dla Klara', 'dla Klara'],
    });
    expect(pdf.pageCount).toBe(8);
    expect(pdf.firstPageBoxes.mediaBox.width).toBeGreaterThan(
      pdf.firstPageBoxes.bleedBox.width,
    );
    expect(pdf.firstPageBoxes.bleedBox.width).toBeGreaterThan(
      pdf.firstPageBoxes.trimBox.width,
    );

    guard.assertClean();
  });

  test('T3A-05: Catalog draft validation (valid + dry-run preflight vs broken vs 02-31) and non-destructive /api/catalog/drafts staging roundtrip', async ({
    request,
  }) => {
    const uniqueSuffix = Date.now().toString(36);
    const validCandidate = {
      id: `e2e-winter-lanterns-${uniqueSuffix}`,
      label: 'Zimowe Lampiony Nad Jeziorem',
      theme:
        'ciepła zimowa opowieść o wieczornym spacerze z papierowymi lampionami nad zamarzniętym jeziorem i spotkaniu leśnych przyjaciół',
      suggestedMood: 'warm-cozy',
      suggestedArtStyle: 'watercolor',
      season: 'winter',
      badge: 'Ferie',
      priority: 12,
      activeWindow: { startMonthDay: '02-01', endMonthDay: '02-20' },
      ageRange: { min: 3, max: 9 },
      tags: ['zima', 'lampiony', 'jezioro'],
    };

    const validRes = await request.post('/api/catalog/validate', {
      data: { theme: validCandidate },
    });
    expect(validRes.status()).toBe(200);
    expectRequestIdHeader(validRes);
    const validBody = (await validRes.json()) as {
      valid: boolean;
      errors: unknown[];
      dryRunPreflight?: { readyForPrint: boolean; score: number };
    };
    expect(validBody.valid).toBe(true);
    expect(validBody.errors).toEqual([]);
    expect(validBody.dryRunPreflight?.readyForPrint).toBe(true);
    expect(validBody.dryRunPreflight?.score ?? 0).toBeGreaterThanOrEqual(80);

    const brokenRes = await request.post('/api/catalog/validate', {
      data: {
        theme: {
          id: 'lantern-forest',
          label: 'Ze {{TODO}}',
          theme: 'Krótki tekst {{TODO}} z niepoprawnym zakresem wieku',
          suggestedMood: 'warm-cozy',
          suggestedArtStyle: 'watercolor',
          season: 'winter',
          badge: 'Test',
          priority: 10,
          activeWindow: { startMonthDay: '02-01', endMonthDay: '02-20' },
          ageRange: { min: 10, max: 3 },
          tags: ['broken'],
        },
      },
    });
    expectRequestIdHeader(brokenRes);
    expect([200, 400, 422]).toContain(brokenRes.status());
    const brokenBody = (await brokenRes.json()) as {
      valid?: boolean;
      errors?: unknown[];
      code?: string;
    };
    if (brokenRes.status() === 200) {
      expect(brokenBody.valid).toBe(false);
      expect(
        Array.isArray(brokenBody.errors) && brokenBody.errors.length >= 2,
      ).toBe(true);
    } else {
      expect(brokenBody.code).toBeTruthy();
    }

    const badDateRes = await request.post('/api/catalog/validate', {
      data: {
        theme: {
          ...validCandidate,
          id: `e2e-bad-feb-${uniqueSuffix}`,
          activeWindow: { startMonthDay: '02-31', endMonthDay: '03-10' },
        },
      },
    });
    expectRequestIdHeader(badDateRes);
    expect([200, 400, 422]).toContain(badDateRes.status());
    const badDateBody = (await badDateRes.json()) as {
      valid?: boolean;
      errors?: unknown[];
    };
    expect(badDateBody.valid).not.toBe(true);

    const feb31QueryRes = await request.get(
      '/api/catalog/themes?date=2026-02-31',
    );
    await expectApiErrorEnvelope(feb31QueryRes, { status: 400 });

    const strictIntQueryRes = await request.get(
      '/api/catalog/themes?upcomingDays=10abc',
    );
    await expectApiErrorEnvelope(strictIntQueryRes, { status: 400 });

    const stageRes = await request.post('/api/catalog/drafts', {
      headers: getOpsAuthHeaders(),
      data: { theme: validCandidate },
    });
    expect(
      [200, 201],
      `POST /api/catalog/drafts failed: ${await stageRes.text()}`,
    ).toContain(stageRes.status());
    expectRequestIdHeader(stageRes);

    const listDraftsRes = await request.get('/api/catalog/drafts', {
      headers: getOpsAuthHeaders(),
    });
    expect(listDraftsRes.status()).toBe(200);
    expectRequestIdHeader(listDraftsRes);
    const draftsText = await listDraftsRes.text();
    expect(draftsText).toContain(validCandidate.id);

    const liveCatalogRes = await request.get(
      '/api/catalog/themes?includeInactive=true',
    );
    expect(liveCatalogRes.status()).toBe(200);
    const liveCatalog = (await liveCatalogRes.json()) as {
      themes: Array<{ id: string }>;
    };
    expect(
      liveCatalog.themes.some((t) => t.id === validCandidate.id),
      'Staged draft must never mutate live themes.json catalog',
    ).toBe(false);
  });
});
