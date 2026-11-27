import { expect, test } from '@playwright/test';
import { getChildPhotosBatch } from './fixtures/images';
import {
  attachErrorGuards,
  expectBinaryPdfDownload,
  expectLoadedImage,
  expectPdfApiHeaders,
  fetchStoryViaApi,
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
  fillAndSubmitOrderDraftForm,
  getOpsAuthHeaders,
  getPrintReadyIllustrationPng,
  lookupOrderStatusViaUi,
  openPreflightPanel,
  purgeReferencePhotosViaUi,
  runRetentionSweepViaApi,
  transitionOrderViaApi,
  triggerPrintReadyPdfDownload,
  uniqueIdempotencyKey,
  uploadIllustrationViaApi,
  verifyPdfBuffer,
  type AgenticResourceTracker,
  type ExtendedStoryRecordDto,
  type ExtendedStorySummaryDto,
  type OrderRecordDto,
  type PreflightReportDto,
  type PrintJobManifestDto,
} from './agentic-helpers';

test.describe('Tier 1 — Agentic Foundations Feature Coverage', () => {
  let activeTracker: AgenticResourceTracker | null = null;

  test.afterEach(async () => {
    if (activeTracker) {
      await activeTracker.cleanup();
      activeTracker = null;
    }
  });

  test('T1A-01: GET /api/health readiness, X-Request-Id echo/generation, and unified error envelope', async ({
    request,
  }) => {
    const tracedRes = await request.get('/api/health', {
      headers: { 'X-Request-Id': 'e2e-health-trace-001' },
    });
    expect(tracedRes.status()).toBe(200);
    expectRequestIdHeader(tracedRes, 'e2e-health-trace-001');
    expect((tracedRes.headers()['cache-control'] ?? '').toLowerCase()).toContain(
      'no-store',
    );

    const healthBody = (await tracedRes.json()) as Record<string, unknown>;
    const normalizedStatus = String(healthBody.status ?? '').toLowerCase();
    expect(
      ['ok', 'degraded', 'healthy'].includes(normalizedStatus) ||
        healthBody.ok === true,
      `Unexpected /api/health status payload: ${JSON.stringify(healthBody)}`,
    ).toBe(true);

    const serialized = JSON.stringify(healthBody).toLowerCase();
    for (const domainKeyword of ['storage', 'font', 'catalog', 'quota']) {
      expect(
        serialized,
        `Expected /api/health payload to include "${domainKeyword}" diagnostic`,
      ).toContain(domainKeyword);
    }

    const checks = healthBody.checks;
    expect(checks && typeof checks === 'object').toBe(true);
    const checkEntries = Array.isArray(checks)
      ? checks
      : Object.values(checks as Record<string, unknown>);
    expect(checkEntries.length).toBeGreaterThanOrEqual(4);
    for (const entry of checkEntries) {
      if (entry && typeof entry === 'object' && 'status' in entry) {
        const entryStatus = String(
          (entry as { status?: unknown }).status ?? '',
        ).toLowerCase();
        expect(['fail', 'error', 'unhealthy']).not.toContain(entryStatus);
      }
    }

    const autoIdRes = await request.get('/api/health');
    expect(autoIdRes.status()).toBe(200);
    const generatedId = expectRequestIdHeader(autoIdRes);
    expect(generatedId.length).toBeGreaterThanOrEqual(8);

    const missingStoryRes = await request.get(
      '/api/stories/missing-story-e2e-999',
      {
        headers: { 'X-Request-Id': 'e2e-err-404-001' },
      },
    );
    await expectApiErrorEnvelope(missingStoryRes, {
      status: 404,
      code: 'NOT_FOUND',
      expectedRequestId: 'e2e-err-404-001',
    });

    const malformedJsonRes = await request.patch(
      '/api/stories/missing-story-e2e-999',
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Request-Id': 'e2e-err-400-001',
        },
        data: '{invalid',
      },
    );
    await expectApiErrorEnvelope(malformedJsonRes, {
      status: 400,
      expectedRequestId: 'e2e-err-400-001',
    });
  });

  test('T1A-02: GET /api/ops/summary and POST /api/ops/retention/sweep (dry-run vs execute + preview lock)', async ({
    page,
    request,
  }) => {
    activeTracker = createAgenticTracker(page, request);

    const completeStory = await createExtendedStoryViaApi(request, {
      childName: 'PolaRet',
      pageCount: 4,
      provider: 'demo',
      generationMode: 'full',
    });
    activeTracker.trackStory(completeStory.id);
    expect(completeStory.generationStage).toBe('complete');
    expect(completeStory.referencePhotos.length).toBeGreaterThanOrEqual(1);

    const previewStory = await createExtendedStoryViaApi(request, {
      childName: 'NelaPrev',
      pageCount: 4,
      provider: 'demo',
      generationMode: 'preview-first',
    });
    activeTracker.trackStory(previewStory.id);
    expect(previewStory.generationStage).toBe('preview');
    expect(previewStory.referencePhotos.length).toBeGreaterThanOrEqual(1);

    const summaryRes = await request.get('/api/ops/summary', {
      headers: getOpsAuthHeaders({ 'X-Request-Id': 'e2e-ops-sum-01' }),
    });
    expect(summaryRes.status()).toBe(200);
    expectRequestIdHeader(summaryRes, 'e2e-ops-sum-01');
    expect(
      (summaryRes.headers()['cache-control'] ?? '').toLowerCase(),
    ).toContain('no-store');

    const summaryBody = (await summaryRes.json()) as Record<string, unknown>;
    const summaryJson = JSON.stringify(summaryBody).toLowerCase();
    expect(summaryJson).toContain('stories');
    expect(summaryJson).toContain('quota');

    const dryRun = await runRetentionSweepViaApi(request, { dryRun: true });
    expect(dryRun.body.dryRun).toBe(true);

    const completePhotoAfterDry = await request.get(
      `/api/stories/${encodeURIComponent(completeStory.id)}/assets/${encodeURIComponent(completeStory.referencePhotos[0])}`,
    );
    expect(
      completePhotoAfterDry.status(),
      'Dry-run retention sweep must not delete reference photos',
    ).toBe(200);

    const executeRun = await runRetentionSweepViaApi(request, { dryRun: false });
    expect(executeRun.body.dryRun).toBe(false);

    const completePhotoAfterExec = await request.get(
      `/api/stories/${encodeURIComponent(completeStory.id)}/assets/${encodeURIComponent(completeStory.referencePhotos[0])}`,
    );
    await expectApiErrorEnvelope(completePhotoAfterExec, { status: 404 });

    const completeRefreshed = (await fetchStoryViaApi(
      request,
      completeStory.id,
    )) as ExtendedStoryRecordDto;
    expect(completeRefreshed.referencePhotos).toEqual([]);
    expect(completeRefreshed.referencePhotosPurgedAt).toBeTruthy();

    const previewPhotoAfterExec = await request.get(
      `/api/stories/${encodeURIComponent(previewStory.id)}/assets/${encodeURIComponent(previewStory.referencePhotos[0])}`,
    );
    expect(
      previewPhotoAfterExec.status(),
      'Incomplete preview story must be protected by retention safety lock',
    ).toBe(200);
  });

  test('T1A-03: Seasonal catalog API (date, includeInactive, upcomingDays, age, validate) and Creator Studio seasonal UI', async ({
    page,
    request,
  }) => {
    const guard = attachErrorGuards(page);

    const decRes = await request.get(
      '/api/catalog/themes?date=2026-12-06&upcomingDays=45',
    );
    expect(decRes.status()).toBe(200);
    expectRequestIdHeader(decRes);
    expect((decRes.headers()['cache-control'] ?? '').toLowerCase()).toContain(
      'no-store',
    );
    const decBody = (await decRes.json()) as {
      referenceDate: string;
      themes: Array<{ id: string; ageRange?: { min: number; max: number } }>;
      activeCount: number;
      upcomingSeasonal: Array<{ id: string; startsInDays: number }>;
    };
    expect(decBody.referenceDate).toBe('2026-12-06');
    expect(decBody.themes[0]?.id).toBe('winter-star-express');
    expect(decBody.activeCount).toBe(decBody.themes.length);
    const upcomingGrandparents = decBody.upcomingSeasonal.find(
      (item) => item.id === 'grandparents-memory-jar',
    );
    expect(upcomingGrandparents).toBeTruthy();
    expect(upcomingGrandparents!.startsInDays).toBeGreaterThan(0);
    expect(upcomingGrandparents!.startsInDays).toBeLessThanOrEqual(45);

    const juneRes = await request.get('/api/catalog/themes?date=2026-06-01');
    expect(juneRes.status()).toBe(200);
    const juneBody = (await juneRes.json()) as {
      themes: Array<{ id: string }>;
    };
    expect(juneBody.themes[0]?.id).toBe('childrens-day-island');

    const allRes = await request.get(
      '/api/catalog/themes?date=2026-12-06&includeInactive=true',
    );
    expect(allRes.status()).toBe(200);
    const allBody = (await allRes.json()) as {
      themes: Array<{ id: string }>;
      activeCount: number;
    };
    expect(allBody.themes.length).toBeGreaterThan(allBody.activeCount);
    expect(allBody.themes.length).toBeGreaterThanOrEqual(12);
    const allIds = allBody.themes.map((t) => t.id);
    expect(allIds).toContain('easter-meadow-quest');
    expect(allIds).toContain('summer-amber-cove');

    const ageRes = await request.get('/api/catalog/themes?date=2026-12-06&age=5');
    expect(ageRes.status()).toBe(200);
    const ageBody = (await ageRes.json()) as {
      themes: Array<{ id: string; ageRange?: { min: number; max: number } }>;
    };
    expect(ageBody.themes.length).toBeGreaterThanOrEqual(6);
    for (const item of ageBody.themes) {
      if (item.ageRange) {
        expect(item.ageRange.min).toBeLessThanOrEqual(5);
        expect(item.ageRange.max).toBeGreaterThanOrEqual(5);
      }
    }

    const validateRes = await request.post('/api/catalog/validate', {
      data: {
        theme: {
          id: 'e2e-winter-sled-test',
          label: 'Zimowa Wyprawa Saniami',
          theme:
            'wesoła zimowa wyprawa drewnianymi saniami przez ośnieżony las w poszukiwaniu ciepłego schroniska',
          suggestedMood: 'warm-cozy',
          suggestedArtStyle: 'watercolor',
          season: 'winter',
          badge: 'Zima',
          priority: 15,
          activeWindow: { startMonthDay: '01-26', endMonthDay: '02-28' },
          ageRange: { min: 3, max: 8 },
          tags: ['zima', 'sanie', 'las'],
        },
      },
    });
    expect(validateRes.status()).toBe(200);
    expectRequestIdHeader(validateRes);
    const validateBody = (await validateRes.json()) as {
      valid: boolean;
      errors: unknown[];
      warnings: unknown[];
      dryRunPreflight?: { readyForPrint: boolean; score: number };
    };
    expect(validateBody.valid).toBe(true);
    expect(validateBody.errors).toEqual([]);
    expect(Array.isArray(validateBody.warnings)).toBe(true);
    if (validateBody.dryRunPreflight) {
      expect(validateBody.dryRunPreflight.readyForPrint).toBe(true);
      expect(typeof validateBody.dryRunPreflight.score).toBe('number');
    }

    const liveActiveRes = await request.get('/api/catalog/themes');
    const liveAllRes = await request.get(
      '/api/catalog/themes?includeInactive=true',
    );
    expect(liveActiveRes.status()).toBe(200);
    expect(liveAllRes.status()).toBe(200);
    const liveActiveCount = (
      (await liveActiveRes.json()) as { themes: unknown[] }
    ).themes.length;
    const liveAllCount = ((await liveAllRes.json()) as { themes: unknown[] })
      .themes.length;

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const rodoNotice = page.getByTestId('rodo-privacy-notice');
    await expect(rodoNotice).toBeVisible();
    await expect(rodoNotice).toContainText(/RODO|zdjęc|usuw/i);

    const chips = page.getByTestId('inspiration-chip');
    await expect(chips).toHaveCount(liveActiveCount);
    expect(liveActiveCount).toBeGreaterThanOrEqual(6);

    const toggleBtn = page.getByTestId('toggle-all-themes-btn');
    await expect(toggleBtn).toBeVisible();
    await toggleBtn.click();
    await expect(chips).toHaveCount(liveAllCount);
    expect(liveAllCount).toBeGreaterThan(liveActiveCount);

    const seasonalChip = page
      .locator(
        '[data-testid="inspiration-chip"][data-season]:not([data-season="evergreen"])',
      )
      .first();
    await expect(seasonalChip).toBeVisible();
    await seasonalChip.click();

    const filledTheme = await page.getByTestId('theme-input').inputValue();
    expect(filledTheme.trim().length).toBeGreaterThan(5);
    const pressedAttr = await seasonalChip.getAttribute('aria-pressed');
    const className = (await seasonalChip.getAttribute('class')) ?? '';
    expect(
      pressedAttr === 'true' || /\bis-active\b|\bactive\b/.test(className),
    ).toBe(true);

    await toggleBtn.click();
    await expect(chips).toHaveCount(liveActiveCount);

    guard.assertClean();
  });

  test('T1A-04: Print preflight API (square & a4-landscape) and StoryReader preflight badge, panel & click-to-jump', async ({
    page,
    request,
  }) => {
    const guard = attachErrorGuards(page);
    activeTracker = createAgenticTracker(page, request);

    const story = await createExtendedStoryViaApi(request, {
      childName: 'ZosiaPre',
      pageCount: 10,
      bookFormat: 'square',
      provider: 'demo',
    });
    activeTracker.trackStory(story.id);

    const squareRes = await request.get(
      `/api/stories/${encodeURIComponent(story.id)}/preflight?format=square`,
    );
    expect(squareRes.status()).toBe(200);
    expectRequestIdHeader(squareRes);
    expect((squareRes.headers()['cache-control'] ?? '').toLowerCase()).toContain(
      'no-store',
    );
    const { report: squareReport } = (await squareRes.json()) as {
      report: PreflightReportDto;
    };
    expect(squareReport.storyId).toBe(story.id);
    expect(squareReport.format).toBe('square');
    expect(squareReport.readyForPrint).toBe(true);
    expect(squareReport.summary.errors).toBe(0);
    expect(squareReport.score).toBeGreaterThanOrEqual(0);
    expect(squareReport.score).toBeLessThanOrEqual(100);
    expect(squareReport.metrics.storyPages).toBe(10);
    expect(squareReport.metrics.totalPdfPages).toBe(13);
    expect(squareReport.metrics.paddingNeededForMultipleOf4).toBe(3);
    expect(squareReport.metrics.expectedArtworkSlots).toBe(11);
    expect(squareReport.metrics.readyArtworkSlots).toBe(11);
    expect(squareReport.metrics.minEffectiveDpi ?? 0).toBeGreaterThanOrEqual(
      100,
    );
    expect(
      squareReport.issues.some(
        (issue) =>
          issue.code === 'PAGE_COUNT_PADDING_RECOMMENDED' &&
          issue.severity === 'info',
      ),
    ).toBe(true);

    const a4Res = await request.get(
      `/api/stories/${encodeURIComponent(story.id)}/preflight?format=a4-landscape`,
    );
    expect(a4Res.status()).toBe(200);
    const { report: a4Report } = (await a4Res.json()) as {
      report: PreflightReportDto;
    };
    expect(a4Report.format).toBe('a4-landscape');
    expect(a4Report.readyForPrint).toBe(true);

    await page.goto(`/story/${encodeURIComponent(story.id)}?slide=0`, {
      waitUntil: 'domcontentloaded',
    });
    await openPreflightPanel(page);
    await expect(page.getByTestId('preflight-issue-item').first()).toBeVisible();

    const patchRes = await request.patch(
      `/api/stories/${encodeURIComponent(story.id)}/pages/2`,
      {
        data: { text: 'Krótki.' },
      },
    );
    expect(patchRes.status()).toBe(200);

    await page.goto(`/story/${encodeURIComponent(story.id)}?slide=0`, {
      waitUntil: 'domcontentloaded',
    });
    await openPreflightPanel(page);

    const page2Issue = page
      .getByTestId('preflight-issue-item')
      .filter({ hasText: /stron[ay]?\s*2|krótki|TEXT_TOO_SHORT/i })
      .first();
    await expect(page2Issue).toBeVisible();
    await page2Issue.click();
    await expect(page).toHaveURL(new RegExp(`\\?slide=3(?:&|$)`));

    guard.assertClean();
  });

  test('T1A-05: Print-ready PDF (bleed+crop+pad, interior, cover-wrap, home-print compat) and StoryReader print-ready download UI', async ({
    page,
    request,
  }) => {
    const guard = attachErrorGuards(page);
    activeTracker = createAgenticTracker(page, request);

    const story = await createExtendedStoryViaApi(request, {
      childName: 'Zosia',
      gender: 'girl',
      pageCount: 10,
      bookFormat: 'square',
      provider: 'demo',
    });
    activeTracker.trackStory(story.id);

    const printRes = await request.get(
      `/api/stories/${encodeURIComponent(story.id)}/pdf?format=square&bleedMm=3&cropMarks=true&padToMultipleOf4=true`,
    );
    expect(printRes.status()).toBe(200);
    expectPdfApiHeaders(printRes.headers());
    expectRequestIdHeader(printRes);
    const printPdf = await verifyPdfBuffer(Buffer.from(await printRes.body()), {
      format: 'square',
      bleedMm: 3,
      cropMarks: true,
      padToMultipleOf4: true,
      expectedPageCount: 16,
      expectedTextSnippets: ['Zosi'],
      forbiddenTextSnippets: ['dla Zosia', 'Dla Zosia'],
    });
    expect(printPdf.extractedText?.toLowerCase()).toContain('dla zosi');

    const interiorPaddedRes = await request.get(
      `/api/stories/${encodeURIComponent(story.id)}/pdf?format=square&bleedMm=3&layoutMode=interior&padToMultipleOf4=true`,
    );
    expect(interiorPaddedRes.status()).toBe(200);
    expectPdfApiHeaders(interiorPaddedRes.headers());
    const interiorPadded = await verifyPdfBuffer(
      Buffer.from(await interiorPaddedRes.body()),
      {
        format: 'square',
        layoutMode: 'interior',
        bleedMm: 3,
        cropMarks: false,
        padToMultipleOf4: true,
      },
    );
    expect(interiorPadded.pageCount).toBeGreaterThanOrEqual(12);
    expect(interiorPadded.pageCount).toBeLessThanOrEqual(16);

    const interiorRawRes = await request.get(
      `/api/stories/${encodeURIComponent(story.id)}/pdf?format=square&layoutMode=interior`,
    );
    expect(interiorRawRes.status()).toBe(200);
    const interiorRaw = await verifyPdfBuffer(
      Buffer.from(await interiorRawRes.body()),
      {
        format: 'square',
        layoutMode: 'interior',
        bleedMm: 0,
        cropMarks: false,
        forbiddenTextSnippets: ['O TEJ KSIĄŻECZCE'],
      },
    );
    expect(interiorRaw.pageCount).toBeLessThan(13);

    const coverWrapRes = await request.get(
      `/api/stories/${encodeURIComponent(story.id)}/pdf?format=square&bleedMm=3&layoutMode=cover-wrap&spineMm=8`,
    );
    expect(coverWrapRes.status()).toBe(200);
    expectPdfApiHeaders(coverWrapRes.headers());
    await verifyPdfBuffer(Buffer.from(await coverWrapRes.body()), {
      format: 'square',
      layoutMode: 'cover-wrap',
      bleedMm: 3,
      spineMm: 8,
      cropMarks: false,
      expectedPageCount: 1,
    });

    const homeRes = await request.get(
      `/api/stories/${encodeURIComponent(story.id)}/pdf?format=square`,
    );
    expect(homeRes.status()).toBe(200);
    await verifyPdfBuffer(Buffer.from(await homeRes.body()), {
      format: 'square',
      bleedMm: 0,
      cropMarks: false,
      expectedPageCount: 13,
    });

    await page.goto(`/story/${encodeURIComponent(story.id)}?slide=0`, {
      waitUntil: 'domcontentloaded',
    });

    const uiPrintPdf = await triggerPrintReadyPdfDownload(page, 'square', {
      bleedMm: 3,
      cropMarks: true,
      padToMultipleOf4: true,
      expectedPageCount: 16,
      expectedQueryParams: {
        format: 'square',
        bleedMm: '3',
      },
    });
    expect(uiPrintPdf.pageCount).toBe(16);
    await expect(page.getByTestId('download-pdf-print-a4')).toBeVisible();

    const homeBtn = page.getByTestId('download-pdf-square');
    await expect(homeBtn).toBeVisible();
    await expectBinaryPdfDownload(page, () => homeBtn.click(), {
      expectedFormat: 'square',
      expectedPageCount: 13,
    });

    guard.assertClean();
  });

  test('T1A-06: RODO child photo purge (no-store on ref-*, 2-step UI, 404 assets, StorySummary, PDF/preflight resilience, idempotency)', async ({
    page,
    request,
  }) => {
    const guard = attachErrorGuards(page);
    activeTracker = createAgenticTracker(page, request);

    const story = await createExtendedStoryViaApi(request, {
      childName: 'MilaRodo',
      pageCount: 4,
      provider: 'demo',
      photos: await getChildPhotosBatch(2),
    });
    activeTracker.trackStory(story.id);
    expect(story.referencePhotos).toHaveLength(2);

    const refAssetRes = await request.get(
      `/api/stories/${encodeURIComponent(story.id)}/assets/${encodeURIComponent(story.referencePhotos[0])}`,
    );
    expect(refAssetRes.status()).toBe(200);
    expect(
      (refAssetRes.headers()['x-content-type-options'] ?? '').toLowerCase(),
    ).toBe('nosniff');
    expect(
      (refAssetRes.headers()['cache-control'] ?? '').toLowerCase(),
    ).toContain('no-store');

    const listBeforeRes = await request.get('/api/stories');
    expect(listBeforeRes.status()).toBe(200);
    const listBefore = (await listBeforeRes.json()) as {
      stories: ExtendedStorySummaryDto[];
    };
    const summaryBefore = listBefore.stories.find((s) => s.id === story.id);
    expect(summaryBefore?.referencePhotosCount).toBe(2);
    expect(summaryBefore?.referencePhotosPurgedAt).toBeUndefined();

    await page.goto(`/story/${encodeURIComponent(story.id)}?slide=1`, {
      waitUntil: 'domcontentloaded',
    });
    await expectLoadedImage(page.getByTestId('dedication-photo'));

    const purgeResult = await purgeReferencePhotosViaUi(page, story.id);
    expect(purgeResult.purged).toBe(true);
    expect(purgeResult.storyId).toBe(story.id);
    expect(purgeResult.deletedFiles).toHaveLength(2);
    expect(purgeResult.deletedFiles).toEqual(
      expect.arrayContaining(story.referencePhotos),
    );
    expect(Date.parse(purgeResult.purgedAt)).not.toBeNaN();

    for (const filename of story.referencePhotos) {
      const deletedRes = await request.get(
        `/api/stories/${encodeURIComponent(story.id)}/assets/${encodeURIComponent(filename)}`,
      );
      await expectApiErrorEnvelope(deletedRes, { status: 404 });
    }

    const refreshedStory = (await fetchStoryViaApi(
      request,
      story.id,
    )) as ExtendedStoryRecordDto;
    expect(refreshedStory.referencePhotos).toEqual([]);
    expect(refreshedStory.referencePhotosPurgedAt).toBe(purgeResult.purgedAt);
    expect(refreshedStory.pages).toHaveLength(4);

    const listAfterRes = await request.get('/api/stories');
    expect(listAfterRes.status()).toBe(200);
    const listAfter = (await listAfterRes.json()) as {
      stories: ExtendedStorySummaryDto[];
    };
    const summaryAfter = listAfter.stories.find((s) => s.id === story.id);
    expect(summaryAfter?.referencePhotosCount).toBe(0);
    expect(summaryAfter?.referencePhotosPurgedAt).toBe(purgeResult.purgedAt);

    const preflightRes = await request.get(
      `/api/stories/${encodeURIComponent(story.id)}/preflight?format=square`,
    );
    expect(preflightRes.status()).toBe(200);
    const { report } = (await preflightRes.json()) as {
      report: PreflightReportDto;
    };
    expect(report.readyForPrint).toBe(true);
    expect(
      report.issues.some(
        (issue) =>
          issue.code === 'DEDICATION_PHOTO_ABSENT' && issue.severity === 'info',
      ),
    ).toBe(true);

    const pdfRes = await request.get(
      `/api/stories/${encodeURIComponent(story.id)}/pdf?format=square`,
    );
    expect(pdfRes.status()).toBe(200);
    await verifyPdfBuffer(Buffer.from(await pdfRes.body()), {
      format: 'square',
      expectedPageCount: 7,
    });

    const repeatRes = await request.delete(
      `/api/stories/${encodeURIComponent(story.id)}/reference-photos`,
    );
    expect(repeatRes.status()).toBe(200);
    expectRequestIdHeader(repeatRes);
    const repeatBody = (await repeatRes.json()) as {
      purged: boolean;
      deletedFiles: string[];
      purgedAt: string;
    };
    expect(repeatBody.purged).toBe(true);
    expect(repeatBody.deletedFiles).toEqual([]);
    expect(repeatBody.purgedAt).toBe(purgeResult.purgedAt);

    guard.assertClean();
  });

  test('T1A-07: Order lifecycle APIs (create, list, get, transitions, approve, preflight, print-manifest) + StoryReader draft & /orders UI', async ({
    page,
    request,
  }) => {
    const guard = attachErrorGuards(page);
    activeTracker = createAgenticTracker(page, request);

    const story = await createExtendedStoryViaApi(request, {
      childName: 'WandaOrd',
      pageCount: 10,
      bookFormat: 'square',
      provider: 'demo',
    });
    activeTracker.trackStory(story.id);

    const { status, order } = await createOrderViaApi(request, {
      storyId: story.id,
      bookFormat: 'square',
      quantity: 1,
      totalMinorUnits: 12900,
      shippingAddress: buildTestShippingAddress({
        email: 'zamawiajacy@example.com',
        postalCode: '00-001',
        city: 'Warszawa',
      }),
      idempotencyKey: uniqueIdempotencyKey('e2e-ord-t1'),
    });
    activeTracker.trackOrder(order.id);
    expect(status).toBe(201);
    expect(order.storyId).toBe(story.id);
    expect(order.orderNumber).toMatch(ORDER_NUMBER_RE);
    expect(order.status).toBe('draft');
    expect(order.paymentStatus).toBe('unpaid');
    expect(order.version).toBe(1);

    const getOrderRes = await request.get(
      `/api/orders/${encodeURIComponent(order.id)}`,
      { headers: getOpsAuthHeaders() },
    );
    expect(getOrderRes.status()).toBe(200);
    expectRequestIdHeader(getOrderRes);
    const getOrderBody = (await getOrderRes.json()) as { order: OrderRecordDto };
    expect(getOrderBody.order.id).toBe(order.id);
    expect(getOrderBody.order.orderNumber).toBe(order.orderNumber);
    expect(getOrderBody.order.version).toBe(1);

    const listOrdersRes = await request.get(
      `/api/orders?storyId=${encodeURIComponent(story.id)}`,
      { headers: getOpsAuthHeaders() },
    );
    expect(listOrdersRes.status()).toBe(200);
    expectRequestIdHeader(listOrdersRes);
    const listOrdersBody = (await listOrdersRes.json()) as {
      orders: OrderRecordDto[];
    };
    expect(listOrdersBody.orders.some((o) => o.id === order.id)).toBe(true);

    const toPending = await transitionOrderViaApi(request, order.id, {
      nextStatus: 'awaiting_payment',
      actor: { kind: 'customer', id: 'cust-t1' },
    });
    expect(toPending.status()).toBe(200);
    const pendingBody = (await toPending.json()) as { order: OrderRecordDto };
    expect(pendingBody.order.status).toBe('awaiting_payment');
    expect(pendingBody.order.paymentStatus).toBe('pending');
    expect(pendingBody.order.version).toBe(2);

    const toPaid = await transitionOrderViaApi(request, order.id, {
      nextStatus: 'paid',
      actor: { kind: 'payment-webhook', id: 'wh-t1' },
      patch: { paymentReference: 'pay_t1_001' },
    });
    expect(toPaid.status()).toBe(200);
    const paidBody = (await toPaid.json()) as { order: OrderRecordDto };
    expect(paidBody.order.status).toBe('paid');
    expect(paidBody.order.paymentStatus).toBe('paid');
    expect(paidBody.order.version).toBe(3);

    const approveRes = await request.post(
      `/api/orders/${encodeURIComponent(order.id)}/approve`,
      {
        headers: getOpsAuthHeaders(),
        data: {
          actor: { kind: 'customer', id: 'cust-t1' },
          reason: 'Zatwierdzenie podglądu',
        },
      },
    );
    expect(approveRes.status()).toBe(200);
    const approveBody = (await approveRes.json()) as { order: OrderRecordDto };
    expect(approveBody.order.status).toBe('approved_for_print');
    expect(approveBody.order.customerApprovedAt).toBeTruthy();
    expect(approveBody.order.version).toBe(4);

    const preflightRes = await request.post(
      `/api/orders/${encodeURIComponent(order.id)}/preflight`,
      { headers: getOpsAuthHeaders() },
    );
    expect(preflightRes.status()).toBe(200);
    const preflightBody = (await preflightRes.json()) as {
      order: OrderRecordDto;
      preflight: PreflightReportDto;
    };
    expect(preflightBody.preflight.readyForPrint).toBe(true);
    expect(preflightBody.order.status).toBe('preflight_passed');
    expect(preflightBody.order.preflightPassed).toBe(true);
    expect(preflightBody.order.preflightStoryUpdatedAt).toBe(story.updatedAt);
    expect(preflightBody.order.version).toBe(5);

    const manifestRes = await request.get(
      `/api/orders/${encodeURIComponent(order.id)}/print-manifest`,
      { headers: getOpsAuthHeaders() },
    );
    expect(manifestRes.status()).toBe(200);
    expectRequestIdHeader(manifestRes);
    const { manifest } = (await manifestRes.json()) as {
      manifest: PrintJobManifestDto;
    };
    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.orderId).toBe(order.id);
    expect(manifest.orderNumber).toBe(order.orderNumber);
    expect(manifest.storyId).toBe(story.id);
    expect(manifest.bookFormat).toBe('square');
    expect(manifest.quantity).toBe(1);
    expect(manifest.pdfSpec.bleedMm).toBeGreaterThanOrEqual(3);
    expect(manifest.pdfSpec.padToMultipleOf4).toBe(true);
    expect(manifest.pdfSpec.totalPdfPages % 4).toBe(0);
    expect(manifest.pdfSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.pdfBytesLength).toBeGreaterThan(20_480);
    expect(manifest.preflightScore).toBeGreaterThanOrEqual(0);
    expect(manifest.preflightScore).toBeLessThanOrEqual(100);
    expect(manifest.shippingAddress.city).toBe('Warszawa');
    expect(manifest.idempotencyKey.length).toBeGreaterThan(0);
    expect(Date.parse(manifest.generatedAt)).not.toBeNaN();

    await page.goto(`/story/${encodeURIComponent(story.id)}?slide=0`, {
      waitUntil: 'domcontentloaded',
    });
    const uiOrder = await fillAndSubmitOrderDraftForm(page, {
      recipientName: 'Janina Rodzic',
      line1: 'ul. Wiosenna 8',
      postalCode: '02-123',
      city: 'Warszawa',
      email: 'rodzic-ui@example.com',
    });
    activeTracker.trackOrder(uiOrder.orderId);

    await page.goto('/orders', { waitUntil: 'domcontentloaded' });
    await lookupOrderStatusViaUi(page, uiOrder.orderNumber, 'rodzic-ui@example.com', {
      expectedStatus: 200,
    });
    const statusCard = page.getByTestId('order-status-card');
    await expect(statusCard).toBeVisible();
    await expect(statusCard).toContainText(uiOrder.orderNumber);

    guard.assertClean();
  });

  test('T1A-08: Customer support APIs (KB search, order-status lookup + PII minimization, inquiries) and /pomoc Polish FAQ UI', async ({
    page,
    request,
  }) => {
    const guard = attachErrorGuards(page);
    activeTracker = createAgenticTracker(page, request);

    const story = await createExtendedStoryViaApi(request, {
      childName: 'KacperSup',
      pageCount: 4,
      provider: 'demo',
    });
    activeTracker.trackStory(story.id);

    const { order } = await createOrderViaApi(request, {
      storyId: story.id,
      shippingAddress: buildTestShippingAddress({
        recipientName: 'Marek Klient',
        line1: 'ul. Sekretnika 7',
        postalCode: '31-001',
        city: 'Kraków',
        email: 'klient-support@example.com',
      }),
      idempotencyKey: uniqueIdempotencyKey('e2e-sup-t1'),
    });
    activeTracker.trackOrder(order.id);
    await advanceOrderToPreflightPassed(request, order.id);

    const kbAllRes = await request.get('/api/support/kb');
    expect(kbAllRes.status()).toBe(200);
    expectRequestIdHeader(kbAllRes);
    const kbAll = (await kbAllRes.json()) as {
      articles: Array<{
        id: string;
        category: string;
        policyStatus: string;
      }>;
      total: number;
    };
    expect(kbAll.articles.length).toBeGreaterThanOrEqual(4);
    expect(kbAll.total).toBeGreaterThanOrEqual(kbAll.articles.length);
    for (const article of kbAll.articles) {
      expect(article.id.length).toBeGreaterThan(0);
      expect(['confirmed', 'tbd_business_decision']).toContain(
        article.policyStatus,
      );
    }

    const kbRodoRes = await request.get('/api/support/kb?q=RODO');
    expect(kbRodoRes.status()).toBe(200);
    const kbRodo = (await kbRodoRes.json()) as {
      articles: unknown[];
      total: number;
    };
    expect(kbRodo.articles.length).toBeGreaterThanOrEqual(1);
    expect(kbRodo.total).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(kbRodo.articles)).toMatch(/RODO|zdjęc/i);

    const firstCategory = kbAll.articles[0].category;
    const kbCatRes = await request.get(
      `/api/support/kb?category=${encodeURIComponent(firstCategory)}`,
    );
    expect(kbCatRes.status()).toBe(200);
    const kbCat = (await kbCatRes.json()) as {
      articles: Array<{ category: string }>;
    };
    expect(kbCat.articles.length).toBeGreaterThanOrEqual(1);
    for (const article of kbCat.articles) {
      expect(article.category).toBe(firstCategory);
    }

    const statusByEmailRes = await request.post('/api/support/order-status', {
      data: {
        orderNumber: order.orderNumber,
        verification: 'klient-support@example.com',
      },
    });
    expect(statusByEmailRes.status()).toBe(200);
    expectRequestIdHeader(statusByEmailRes);
    const statusByEmail = (await statusByEmailRes.json()) as {
      found: boolean;
      statusView: Record<string, unknown>;
    };
    expect(statusByEmail.found).toBe(true);
    const statusJson = JSON.stringify(statusByEmail.statusView);
    expect(statusJson).toContain(order.orderNumber);
    expect(statusJson).not.toContain('ul. Sekretnika 7');
    expect(statusJson).not.toContain('klient-support@example.com');

    const statusByPostalRes = await request.post('/api/support/order-status', {
      data: {
        orderNumber: order.orderNumber,
        verification: '31-001',
      },
    });
    expect(statusByPostalRes.status()).toBe(200);
    const statusByPostal = (await statusByPostalRes.json()) as {
      found: boolean;
      statusView: Record<string, unknown>;
    };
    expect(statusByPostal.found).toBe(true);
    expect(JSON.stringify(statusByPostal.statusView)).toContain(
      order.orderNumber,
    );

    const routineRes = await request.post('/api/support/inquiries', {
      data: {
        customerEmail: 'pytajacy@example.com',
        subject: 'Formaty książek',
        message:
          'Jakie wymiary ma książka kwadratowa i jak przygotować zdjęcia?',
      },
    });
    expect([200, 201]).toContain(routineRes.status());
    expectRequestIdHeader(routineRes);
    const routineBody = (await routineRes.json()) as {
      ticket: { id: string };
      escalation: { shouldEscalate: boolean; reasons: string[] };
      suggestedArticles: unknown[];
    };
    expect(routineBody.ticket.id.length).toBeGreaterThan(0);
    expect(Array.isArray(routineBody.escalation.reasons)).toBe(true);
    expect(Array.isArray(routineBody.suggestedArticles)).toBe(true);

    const escalateRes = await request.post('/api/support/inquiries', {
      data: {
        customerEmail: 'zwrot@example.com',
        orderNumber: order.orderNumber,
        subject: 'Zwrot pieniędzy',
        message:
          'Proszę o zwrot pieniędzy za zamówienie, mój telefon 501 222 333, PESEL 85050512345.',
      },
    });
    expect([200, 201]).toContain(escalateRes.status());
    const escalateBody = (await escalateRes.json()) as {
      ticket: Record<string, unknown>;
      escalation: { shouldEscalate: boolean; reasons: string[] };
    };
    expect(escalateBody.escalation.shouldEscalate).toBe(true);
    expect(escalateBody.escalation.reasons.length).toBeGreaterThanOrEqual(1);
    const ticketSerialized = JSON.stringify(escalateBody.ticket);
    expect(ticketSerialized).not.toContain('85050512345');
    expect(ticketSerialized).not.toContain('501 222 333');

    await page.goto('/pomoc', { waitUntil: 'domcontentloaded' });
    const searchInput = page.getByTestId('kb-search-input');
    await expect(searchInput).toBeVisible();
    await expect(page.getByTestId('help-order-lookup')).toBeVisible();

    const cards = page.getByTestId('kb-article-card');
    const initialCardCount = await cards.count();
    expect(initialCardCount).toBeGreaterThanOrEqual(3);

    await searchInput.fill('RODO');
    await expect
      .poll(async () => cards.count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1);
    await expect(cards.first()).toContainText(/RODO|zdjęc/i);

    await searchInput.fill('');
    await expect(cards).toHaveCount(initialCardCount);

    guard.assertClean();
  });

  test('T1A-09: Manual-mode 4-page custom art upload promotes generationStage to complete only on final slot and passes print preflight', async ({
    page,
    request,
  }) => {
    activeTracker = createAgenticTracker(page, request);

    const story = await createExtendedStoryViaApi(request, {
      childName: 'BorysMan',
      gender: 'boy',
      pageCount: 4,
      bookFormat: 'square',
      provider: 'manual',
    });
    activeTracker.trackStory(story.id);
    expect(story.generationStage).toBe('awaiting-manual-art');

    const initialPreflightRes = await request.get(
      `/api/stories/${encodeURIComponent(story.id)}/preflight?format=square`,
    );
    expect(initialPreflightRes.status()).toBe(200);
    const { report: initialReport } = (await initialPreflightRes.json()) as {
      report: PreflightReportDto;
    };
    expect(initialReport.readyForPrint).toBe(false);
    const initialCodes = initialReport.issues.map((i) => i.code);
    expect(initialCodes).toContain('STORY_INCOMPLETE_STAGE');
    expect(initialCodes).toContain('MISSING_ARTWORK');

    const coverArt = await getPrintReadyIllustrationPng('cover');
    const pageArt = await getPrintReadyIllustrationPng('page');

    await uploadIllustrationViaApi(request, story.id, 'cover', coverArt);
    await uploadIllustrationViaApi(request, story.id, 1, pageArt);
    await uploadIllustrationViaApi(request, story.id, 2, pageArt);
    await uploadIllustrationViaApi(request, story.id, 3, pageArt);

    const midStory = await fetchStoryViaApi(request, story.id);
    expect(
      midStory.generationStage,
      'Story must remain awaiting-manual-art while page 4 artwork is still missing',
    ).toBe('awaiting-manual-art');

    await uploadIllustrationViaApi(request, story.id, 4, pageArt);

    const finalStory = await fetchStoryViaApi(request, story.id);
    expect(finalStory.generationStage).toBe('complete');
    expect(finalStory.coverStatus).toBe('custom-uploaded');
    for (const p of finalStory.pages) {
      expect(p.imageStatus).toBe('custom-uploaded');
    }

    const finalPreflightRes = await request.get(
      `/api/stories/${encodeURIComponent(story.id)}/preflight?format=square`,
    );
    expect(finalPreflightRes.status()).toBe(200);
    const { report: finalReport } = (await finalPreflightRes.json()) as {
      report: PreflightReportDto;
    };
    expect(finalReport.readyForPrint).toBe(true);
    expect(finalReport.summary.errors).toBe(0);
    expect(finalReport.metrics.expectedArtworkSlots).toBe(5);
    expect(finalReport.metrics.readyArtworkSlots).toBe(5);
    expect(finalReport.metrics.minEffectiveDpi ?? 0).toBeGreaterThanOrEqual(
      240,
    );

    const pdfRes = await request.get(
      `/api/stories/${encodeURIComponent(story.id)}/pdf?format=square`,
    );
    expect(pdfRes.status()).toBe(200);
    await verifyPdfBuffer(Buffer.from(await pdfRes.body()), {
      format: 'square',
      expectedPageCount: 7,
    });
  });
});
