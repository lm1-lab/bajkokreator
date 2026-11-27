import { expect, test } from '@playwright/test';
import {
  MOBILE_VIEWPORT,
  assertNoHorizontalOverflow,
  attachErrorGuards,
  expectAllVisibleImagesLoaded,
  expectLoadedImage,
  fetchStoryViaApi,
  fillCreatorFormAndSubmit,
  setPreviewFirst,
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
  lookupOrderStatusViaUi,
  openPreflightPanel,
  purgeReferencePhotosViaUi,
  runRetentionSweepViaApi,
  selectSeasonalThemeChip,
  triggerPrintReadyPdfDownload,
  uniqueIdempotencyKey,
  type AgenticResourceTracker,
  type ExtendedStoryRecordDto,
} from './agentic-helpers';

test.describe('Tier 4 — Agentic Real-World End-to-End Scenarios', () => {
  let activeTracker: AgenticResourceTracker | null = null;

  test.afterEach(async () => {
    if (activeTracker) {
      await activeTracker.cleanup();
      activeTracker = null;
    }
  });

  test('Scenario A: Parent seasonal holiday book -> Polish edit -> preflight -> print-ready 16-page PDF -> order draft -> /orders -> RODO purge & monogram fallback', async ({
    page,
    request,
  }) => {
    const guard = attachErrorGuards(page);
    activeTracker = createAgenticTracker(page, request);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('rodo-privacy-notice')).toBeVisible();

    const selectedSeason = await selectSeasonalThemeChip(page);
    expect(selectedSeason.season).not.toBe('evergreen');

    const { storyId } = await fillCreatorFormAndSubmit(page, {
      childName: 'Zosia',
      childAge: 5,
      gender: 'girl',
      companion: 'rudy kotek Mruczek',
      pageCount: 10,
      provider: 'demo',
    });
    activeTracker.trackStory(storyId);

    const createdStory = await fetchStoryViaApi(request, storyId);
    const firstRef = createdStory.referencePhotos[0];
    expect(firstRef).toBeTruthy();

    // Edit Page 1 (?slide=2) with Polish diacritics and verify persistence
    await page.goto(`/story/${encodeURIComponent(storyId)}?slide=2`, {
      waitUntil: 'domcontentloaded',
    });
    await page.getByTestId('edit-text-btn').click();
    const polishEdit =
      'Zażółć gęślą jaźń — Zosia rozświetliła świąteczną gwiazdkę nad całą krainą.';
    await page.getByTestId('edit-text-area').fill(polishEdit);

    const savePromise = page.waitForResponse(
      (res) =>
        res.request().method() === 'PATCH' &&
        new URL(res.url()).pathname ===
          `/api/stories/${encodeURIComponent(storyId)}/pages/1`,
      { timeout: 15_000 },
    );
    await page.getByTestId('save-text-btn').click();
    const saveRes = await savePromise;
    expect(saveRes.status()).toBe(200);
    await expect(page.getByTestId('story-slide')).toContainText(
      'Zażółć gęślą jaźń',
    );

    // Inspect Preflight panel in StoryReader
    await page.goto(`/story/${encodeURIComponent(storyId)}?slide=0`, {
      waitUntil: 'domcontentloaded',
    });
    await openPreflightPanel(page);
    await expect(page.getByTestId('preflight-issue-item').first()).toBeVisible();

    // Download print-ready 16-page Square PDF and verify geometry + Polish Genitive + diacritics
    const pdf = await triggerPrintReadyPdfDownload(page, 'square', {
      bleedMm: 3,
      cropMarks: true,
      padToMultipleOf4: true,
      expectedPageCount: 16,
      expectedTextSnippets: ['Zażółć gęślą jaźń', 'Zosi', 'NOTATKI I RYSUNKI'],
      forbiddenTextSnippets: ['Dla Zosia', 'dla Zosia'],
    });
    expect(pdf.extractedText?.toLowerCase()).toContain('dla zosi');

    // Create print order draft via StoryReader drawer
    const draftOrder = await fillAndSubmitOrderDraftForm(page, {
      recipientName: 'Magdalena Nowak',
      line1: 'ul. Świąteczna 15/3',
      postalCode: '00-512',
      city: 'Warszawa',
      email: 'mama.zosi@example.pl',
    });
    activeTracker.trackOrder(draftOrder.orderId);
    expect(draftOrder.orderNumber).toMatch(ORDER_NUMBER_RE);

    // Look up the created draft order on /orders
    await page.goto('/orders', { waitUntil: 'domcontentloaded' });
    await lookupOrderStatusViaUi(
      page,
      draftOrder.orderNumber,
      'mama.zosi@example.pl',
      { expectedStatus: 200 },
    );
    const statusCard = page.getByTestId('order-status-card');
    await expect(statusCard).toBeVisible();
    await expect(statusCard).toContainText(draftOrder.orderNumber);

    // Return to dedication slide, purge reference photos via 2-step RODO flow, verify monogram fallback
    await page.goto(`/story/${encodeURIComponent(storyId)}?slide=1`, {
      waitUntil: 'domcontentloaded',
    });
    await expectLoadedImage(page.getByTestId('dedication-photo'));

    const purgeResult = await purgeReferencePhotosViaUi(page, storyId);
    expect(purgeResult.purged).toBe(true);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('dedication-photo')).toHaveCount(0);
    await expectAllVisibleImagesLoaded(page);

    const purgedAssetRes = await request.get(
      `/api/stories/${encodeURIComponent(storyId)}/assets/${encodeURIComponent(firstRef)}`,
    );
    await expectApiErrorEnvelope(purgedAssetRes, { status: 404 });

    guard.assertClean();
  });

  test('Scenario B: Customer self-service support (/pomoc FAQ search, wrong-email 404 & positive lookup, damaged-print escalation + PII masking)', async ({
    page,
    request,
  }) => {
    const guard = attachErrorGuards(page);
    activeTracker = createAgenticTracker(page, request);

    const story = await createExtendedStoryViaApi(request, {
      childName: 'FranekPomoc',
      gender: 'boy',
      pageCount: 4,
      provider: 'demo',
    });
    activeTracker.trackStory(story.id);

    const { order } = await createOrderViaApi(request, {
      storyId: story.id,
      shippingAddress: buildTestShippingAddress({
        recipientName: 'Piotr Kowal',
        line1: 'ul. Smocza 14',
        postalCode: '30-001',
        city: 'Kraków',
        email: 'tata.franka@example.pl',
      }),
      idempotencyKey: uniqueIdempotencyKey('e2e-scen-b'),
    });
    activeTracker.trackOrder(order.id);

    await page.goto('/pomoc', { waitUntil: 'domcontentloaded' });
    const kbCards = page.getByTestId('kb-article-card');
    const initialCount = await kbCards.count();
    expect(initialCount).toBeGreaterThanOrEqual(3);

    const searchInput = page.getByTestId('kb-search-input');
    await searchInput.fill('RODO');
    await expect
      .poll(async () => kbCards.count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1);
    await expect(kbCards.first()).toContainText(/RODO|zdjęc/i);

    await searchInput.fill('druk');
    await expect
      .poll(async () => kbCards.count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1);

    await searchInput.fill('');
    await expect(kbCards).toHaveCount(initialCount);

    // Negative order-status lookup inside help-order-lookup widget (404 expected)
    guard.allowExpectedHttpError({
      status: 404,
      urlPattern: /\/api\/support\/order-status/,
    });
    await lookupOrderStatusViaUi(page, order.orderNumber, 'obcy@example.pl', {
      containerTestId: 'help-order-lookup',
      expectedStatus: 404,
    });
    const helpWidget = page.getByTestId('help-order-lookup');
    await expect(helpWidget).not.toContainText('ul. Smocza 14');
    await expect(helpWidget).not.toContainText('tata.franka@example.pl');

    // Positive order-status lookup inside help-order-lookup widget
    await lookupOrderStatusViaUi(
      page,
      order.orderNumber,
      'tata.franka@example.pl',
      {
        containerTestId: 'help-order-lookup',
        expectedStatus: 200,
      },
    );
    const statusCard = page.getByTestId('order-status-card');
    await expect(statusCard).toBeVisible();
    await expect(statusCard).toContainText(order.orderNumber);
    await expect(statusCard).not.toContainText('ul. Smocza 14');

    // Damaged-print support inquiry -> deterministic escalation & PII masking
    const inquiryRes = await request.post('/api/support/inquiries', {
      data: {
        customerEmail: 'tata.franka@example.pl',
        orderNumber: order.orderNumber,
        subject: 'Uszkodzony druk okładki',
        message:
          'Książka dotarła z zalaną okładką. Mój telefon to +48 601 234 567, adres ul. Smocza 14, email tata.franka@example.pl — proszę o wymianę lub zwrot.',
      },
    });
    expect([200, 201]).toContain(inquiryRes.status());
    expectRequestIdHeader(inquiryRes);

    const inquiryBody = (await inquiryRes.json()) as {
      ticket: { id: string } & Record<string, unknown>;
      escalation: { shouldEscalate: boolean; reasons: string[] };
    };
    expect(inquiryBody.escalation.shouldEscalate).toBe(true);
    expect(inquiryBody.escalation.reasons.length).toBeGreaterThanOrEqual(1);
    expect(inquiryBody.ticket.id.length).toBeGreaterThan(0);

    const ticketJson = JSON.stringify(inquiryBody.ticket);
    expect(ticketJson).not.toContain('+48 601 234 567');
    expect(ticketJson).not.toContain('601 234 567');

    const storedTicketRes = await request.get(
      `/api/support/inquiries/${encodeURIComponent(inquiryBody.ticket.id)}`,
      { headers: getOpsAuthHeaders() },
    );
    expect(storedTicketRes.status()).toBe(200);
    expectRequestIdHeader(storedTicketRes);
    const storedTicketText = await storedTicketRes.text();
    expect(storedTicketText).not.toContain('601 234 567');

    guard.assertClean();
  });

  test('Scenario C: Operator supervision (health, ops summary, RODO retention sweep dry-run/execute with active-order lock, catalog draft validation)', async ({
    page,
    request,
  }) => {
    activeTracker = createAgenticTracker(page, request);

    const healthRes = await request.get('/api/health');
    expect(healthRes.status()).toBe(200);
    expectRequestIdHeader(healthRes);
    const health = (await healthRes.json()) as Record<string, unknown>;
    const healthText = JSON.stringify(health).toLowerCase();
    for (const key of ['storage', 'font', 'catalog', 'quota']) {
      expect(healthText).toContain(key);
    }

    const opsBeforeRes = await request.get('/api/ops/summary', {
      headers: getOpsAuthHeaders(),
    });
    expect(opsBeforeRes.status()).toBe(200);
    expectRequestIdHeader(opsBeforeRes);
    const opsBeforeText = (await opsBeforeRes.text()).toLowerCase();
    expect(opsBeforeText).toContain('stories');
    expect(opsBeforeText).toContain('quota');

    const sweepableStory = await createExtendedStoryViaApi(request, {
      childName: 'OliwiaSweep',
      pageCount: 4,
      provider: 'demo',
    });
    activeTracker.trackStory(sweepableStory.id);

    const protectedStory = await createExtendedStoryViaApi(request, {
      childName: 'AntekProt',
      gender: 'boy',
      pageCount: 4,
      provider: 'demo',
    });
    activeTracker.trackStory(protectedStory.id);

    const { order: activeOrder } = await createOrderViaApi(request, {
      storyId: protectedStory.id,
      shippingAddress: buildTestShippingAddress({
        email: 'antek-ops@example.pl',
      }),
      idempotencyKey: uniqueIdempotencyKey('e2e-scen-c'),
    });
    activeTracker.trackOrder(activeOrder.id);
    await advanceOrderToPreflightPassed(request, activeOrder.id);

    // Dry-run sweep: zero mutation
    const dryRun = await runRetentionSweepViaApi(request, { dryRun: true });
    expect(dryRun.body.dryRun).toBe(true);
    const sweepableAfterDry = (await fetchStoryViaApi(
      request,
      sweepableStory.id,
    )) as ExtendedStoryRecordDto;
    expect(sweepableAfterDry.referencePhotos.length).toBeGreaterThanOrEqual(1);

    // Execute sweep: purges sweepableStory, protects protectedStory
    const executeRun = await runRetentionSweepViaApi(request, { dryRun: false });
    expect(executeRun.body.dryRun).toBe(false);

    const sweepableAfterExec = (await fetchStoryViaApi(
      request,
      sweepableStory.id,
    )) as ExtendedStoryRecordDto;
    expect(sweepableAfterExec.referencePhotos).toEqual([]);
    expect(sweepableAfterExec.referencePhotosPurgedAt).toBeTruthy();

    const protectedAfterExec = (await fetchStoryViaApi(
      request,
      protectedStory.id,
    )) as ExtendedStoryRecordDto;
    expect(protectedAfterExec.referencePhotos.length).toBeGreaterThanOrEqual(1);
    expect(protectedAfterExec.referencePhotosPurgedAt).toBeUndefined();

    // Seasonal catalog draft validation
    const validateRes = await request.post('/api/catalog/validate', {
      data: {
        theme: {
          id: `e2e-ops-holiday-${Date.now().toString(36)}`,
          label: 'Ferie w Górskiej Chatce',
          theme:
            'rodzinna przygoda w drewnianej górskiej chatce podczas ferii zimowych, lepienie bałwana i tropienie śladów leśnych zwierząt',
          suggestedMood: 'warm-cozy',
          suggestedArtStyle: 'storybook-gouache',
          season: 'winter',
          badge: 'Ferie',
          priority: 14,
          activeWindow: { startMonthDay: '01-26', endMonthDay: '02-28' },
          ageRange: { min: 3, max: 9 },
          tags: ['ferie', 'zima', 'góry'],
        },
      },
    });
    expect(validateRes.status()).toBe(200);
    expectRequestIdHeader(validateRes);
    const validateBody = (await validateRes.json()) as {
      valid: boolean;
      dryRunPreflight?: { readyForPrint: boolean; score: number };
    };
    expect(validateBody.valid).toBe(true);
    if (validateBody.dryRunPreflight) {
      expect(validateBody.dryRunPreflight.readyForPrint).toBe(true);
    }

    const opsAfterRes = await request.get('/api/ops/summary', {
      headers: getOpsAuthHeaders(),
    });
    expect(opsAfterRes.status()).toBe(200);
    expectRequestIdHeader(opsAfterRes);
  });

  test('Scenario D: Mobile (390x844) zero-horizontal-overflow across all routes & open drawers + Polish grammar, A11y & keyboard nav audit', async ({
    browser,
    page,
    request,
  }) => {
    const desktopGuard = attachErrorGuards(page);
    activeTracker = createAgenticTracker(page, request);

    const story = await createExtendedStoryViaApi(request, {
      childName: 'Zosia',
      childAge: 5,
      gender: 'girl',
      pageCount: 6,
      bookFormat: 'square',
      provider: 'demo',
    });
    activeTracker.trackStory(story.id);

    const mobileContext = await browser.newContext({
      viewport: MOBILE_VIEWPORT,
      locale: 'pl-PL',
    });
    const mobilePage = await mobileContext.newPage();
    const mobileGuard = attachErrorGuards(mobilePage);

    try {
      // 1. / (default + expanded seasonal themes)
      await mobilePage.goto('/', { waitUntil: 'domcontentloaded' });
      await assertNoHorizontalOverflow(mobilePage, 1);
      await expectAllVisibleImagesLoaded(mobilePage);
      await expect(mobilePage.getByTestId('rodo-privacy-notice')).toBeVisible();
      await expect(
        mobilePage.locator('header a[aria-current="page"], nav a[aria-current="page"]').first(),
      ).toBeVisible();

      await mobilePage.getByTestId('toggle-all-themes-btn').click();
      await assertNoHorizontalOverflow(mobilePage, 1);

      // 2. /library
      await mobilePage.goto('/library', { waitUntil: 'domcontentloaded' });
      await assertNoHorizontalOverflow(mobilePage, 1);
      await expectAllVisibleImagesLoaded(mobilePage);
      await expect(
        mobilePage.locator('a[href="/library"][aria-current="page"]').first(),
      ).toBeVisible();

      // 3. /settings (zero literal backticks)
      await mobilePage.goto('/settings', { waitUntil: 'domcontentloaded' });
      await assertNoHorizontalOverflow(mobilePage, 1);
      await expectAllVisibleImagesLoaded(mobilePage);
      await expect(
        mobilePage.locator('a[href="/settings"][aria-current="page"]').first(),
      ).toBeVisible();
      const settingsText = await mobilePage.locator('body').innerText();
      expect(settingsText).not.toContain('`src/lib');
      expect(settingsText).not.toContain('`');

      // 4. /orders
      await mobilePage.goto('/orders', { waitUntil: 'domcontentloaded' });
      await assertNoHorizontalOverflow(mobilePage, 1);
      await expect(
        mobilePage.locator('a[href="/orders"][aria-current="page"]').first(),
      ).toBeVisible();
      await expect(mobilePage.getByTestId('order-lookup-number')).toBeVisible();

      // 5. /pomoc
      await mobilePage.goto('/pomoc', { waitUntil: 'domcontentloaded' });
      await assertNoHorizontalOverflow(mobilePage, 1);
      await expect(
        mobilePage.locator('a[href="/pomoc"][aria-current="page"]').first(),
      ).toBeVisible();
      await expect(mobilePage.getByTestId('kb-search-input')).toBeVisible();
      await expect(
        mobilePage.getByTestId('kb-article-card').first(),
      ).toBeVisible();

      // 6. /story/[id]?slide=0 default + open Preflight + Print-Ready PDF + Order Draft drawer
      await mobilePage.goto(`/story/${encodeURIComponent(story.id)}?slide=0`, {
        waitUntil: 'domcontentloaded',
      });
      await assertNoHorizontalOverflow(mobilePage, 1);
      await expectAllVisibleImagesLoaded(mobilePage);

      await openPreflightPanel(mobilePage);
      await assertNoHorizontalOverflow(mobilePage, 1);

      const printToggle = mobilePage.getByTestId('print-ready-toggle');
      if (await printToggle.isVisible()) {
        await printToggle.click();
        await expect(
          mobilePage.getByTestId('download-pdf-print-square'),
        ).toBeVisible();
        await assertNoHorizontalOverflow(mobilePage, 1);
      }

      const orderDraftBtn = mobilePage.getByTestId('order-draft-btn');
      await orderDraftBtn.click();
      await expect(mobilePage.getByTestId('order-draft-form')).toBeVisible();
      await assertNoHorizontalOverflow(mobilePage, 1);

      // 7. /story/[id]?slide=1 Dedication — Polish Genitive & Polish provider badge
      await mobilePage.goto(`/story/${encodeURIComponent(story.id)}?slide=1`, {
        waitUntil: 'domcontentloaded',
      });
      await assertNoHorizontalOverflow(mobilePage, 1);
      await expectLoadedImage(mobilePage.getByTestId('dedication-photo'));
      const dedicationBody = await mobilePage.locator('body').innerText();
      expect(dedicationBody).toContain('Dla Zosi');
      expect(dedicationBody).not.toContain('Dla Zosia');
      expect(dedicationBody).not.toMatch(/Tryb:\s*demo\b/i);

      // 8. /story/[id]?slide=2 & ?view=all
      await mobilePage.goto(`/story/${encodeURIComponent(story.id)}?slide=2`, {
        waitUntil: 'domcontentloaded',
      });
      await assertNoHorizontalOverflow(mobilePage, 1);
      await expectAllVisibleImagesLoaded(mobilePage);

      await mobilePage.goto(
        `/story/${encodeURIComponent(story.id)}?view=all`,
        { waitUntil: 'domcontentloaded' },
      );
      await assertNoHorizontalOverflow(mobilePage, 1);
      await expectAllVisibleImagesLoaded(mobilePage);

      mobileGuard.assertClean();
    } finally {
      await mobileContext.close();
    }

    // Desktop keyboard slide nav + textarea suppression + Polish pluralization
    await page.goto(`/story/${encodeURIComponent(story.id)}?slide=0`, {
      waitUntil: 'load',
    });
    await expect(page.getByTestId('preflight-badge')).not.toContainText(/sprawdz/i);
    await page.keyboard.press('ArrowRight');
    await expect(page).toHaveURL(/\?slide=1(?:&|$)/);
    await page.keyboard.press('ArrowLeft');
    await expect(page).toHaveURL(/\?slide=0(?:&|$)/);

    await page.goto(`/story/${encodeURIComponent(story.id)}?slide=2`, {
      waitUntil: 'domcontentloaded',
    });
    await page.getByTestId('edit-text-btn').click();
    const editArea = page.getByTestId('edit-text-area');
    await expect(editArea).toBeVisible();
    await editArea.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowLeft');
    await expect(page).toHaveURL(/\?slide=2(?:&|$)/);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await setPreviewFirst(page, true);
    const costEstimate = page.getByTestId('cost-estimate');
    await expect(costEstimate).toBeVisible();
    await expect(costEstimate).toContainText('2 obrazy');
    await expect(costEstimate).not.toContainText('2 obrazów');

    desktopGuard.assertClean();
  });
});
