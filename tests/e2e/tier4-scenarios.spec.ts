import { expect, test } from '@playwright/test';
import {
  getChildPhotoFixture,
  getChildPhotosBatch,
  getCustomIllustrationPng,
} from './fixtures/images';
import {
  MOBILE_VIEWPORT,
  assertNoHorizontalOverflow,
  attachErrorGuards,
  createStoryTracker,
  createStoryViaApi,
  deleteStoryFromLibrary,
  expectAllVisibleImagesLoaded,
  expectBinaryPdfDownload,
  expectLoadedImage,
  expectSsrStoryRoute,
  fetchStoryViaApi,
  fillCreatorFormAndSubmit,
  installClipboardSpy,
  readCopiedPromptAfterClick,
  restoreDefaultSettings,
  uploadFilesToTestId,
  type StoryTracker,
} from './helpers';

test.describe('Tier 4 — Complete Real-World Application Scenarios', () => {
  let activeTracker: StoryTracker | null = null;

  test.afterEach(async () => {
    if (activeTracker) {
      await activeTracker.cleanup();
      activeTracker = null;
    }
  });

  test('Scenario 1: Full DoD Parent-to-Print flow (photo -> Zosia Demo book -> all 13 slides -> Polish edit -> All Pages -> Square & A4 PDF -> /settings -> /library delete)', async ({
    page,
    request,
  }) => {
    const guard = attachErrorGuards(page);
    activeTracker = createStoryTracker(page, request);
    await restoreDefaultSettings(request);

    // 1. Upload child photo, fill Zosia (5, dziewczynka, rudy kotek Mruczek), pick inspiration, create Demo book
    await page.goto('/');
    const { storyId } = await fillCreatorFormAndSubmit(page, {
      photos: [await getChildPhotoFixture(1)],
      childName: 'Zosia',
      childAge: 5,
      gender: 'girl',
      companion: 'rudy kotek Mruczek',
      inspirationIndex: 0,
      artStyle: 'watercolor',
      mood: 'warm-cozy',
      pageCount: 10,
      provider: 'demo',
    });
    activeTracker.track(storyId);

    const story = await fetchStoryViaApi(request, storyId);
    expect(story.pages).toHaveLength(10);

    // 2. Cover (?slide=0)
    await expect(page.getByTestId('story-slide')).toContainText(story.title);
    await expectLoadedImage(page.getByTestId('story-slide').locator('img').first());

    // 3. Dedication (?slide=1) with framed child photo
    await page.getByTestId('slide-next').click();
    await expect(page).toHaveURL(new RegExp(`/story/${storyId}\\?.*slide=1`));
    await expectLoadedImage(page.getByTestId('dedication-photo'));

    // 4. Step through all 10 story pages (?slide=2..11)
    for (let slide = 2; slide <= 11; slide += 1) {
      await page.getByTestId('slide-next').click();
      await expect(page).toHaveURL(
        new RegExp(`/story/${storyId}\\?.*slide=${slide}(?:&|$)`),
      );
      await expectLoadedImage(
        page.getByTestId('story-slide').locator('img').first(),
      );
    }

    // 5. Back Cover (?slide=12)
    await page.getByTestId('slide-next').click();
    await expect(page).toHaveURL(new RegExp(`/story/${storyId}\\?.*slide=12`));
    await expect(page.getByTestId('story-slide')).toContainText(
      story.backCoverBlurb.slice(0, 20),
    );

    // 6. Edit Page 1 (?slide=2) with "Zażółć gęślą jaźń", save, and verify across reload
    const editedPageOne =
      'Zażółć gęślą jaźń — Zosia i rudy kotek Mruczek ruszyli o świcie ku złotej polanie.';
    await page.goto(`/story/${storyId}?slide=2`);
    await page.getByTestId('edit-text-btn').click();
    await page.getByTestId('edit-text-area').fill(editedPageOne);

    const savePromise = page.waitForResponse(
      (res) =>
        res.request().method() === 'PATCH' &&
        res.url().includes(`/api/stories/${storyId}/pages/1`),
    );
    await page.getByTestId('save-text-btn').click();
    expect((await savePromise).status()).toBe(200);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('story-slide')).toContainText(
      'Zażółć gęślą jaźń',
    );

    // 7. View "Wszystkie strony" (?view=all)
    await page.getByTestId('view-all-toggle').click();
    await expect(page).toHaveURL(new RegExp(`/story/${storyId}\\?.*view=all`));
    await expect(page.getByTestId('all-pages-grid')).toBeVisible();
    await expect(page.getByTestId('all-pages-grid')).toContainText(
      'Zażółć gęślą jaźń',
    );

    // 8. Download binary Square 21×21 cm & A4 Landscape %PDF-
    await expectBinaryPdfDownload(
      page,
      async () => {
        await page.getByTestId('download-pdf-square').click();
      },
      {
        expectedFormat: 'square',
        expectedPageCount: 13,
        expectedTextSnippets: ['Zażółć gęślą jaźń', 'Zosi'],
      },
    );

    await expectBinaryPdfDownload(
      page,
      async () => {
        await page.getByTestId('download-pdf-a4').click();
      },
      {
        expectedFormat: 'a4-landscape',
        expectedPageCount: 13,
        expectedTextSnippets: ['Zażółć gęślą jaźń', 'Zosi'],
      },
    );

    // 9. Inspect /settings
    await page.goto('/settings');
    await expect(page.getByTestId('quota-status')).toBeVisible();
    await expect(page.getByTestId('storage-mode-badge')).toBeVisible();
    await expect(page.getByTestId('subscription-adapter-section')).toBeVisible();

    // 10. Open /library, verify cover, delete story via 2-step delete, reload & verify gone
    await page.goto('/library');
    const card = page
      .getByTestId('library-card')
      .filter({ hasText: story.title })
      .first();
    await expect(card).toBeVisible();
    await expectLoadedImage(card.locator('img').first());

    await deleteStoryFromLibrary(page, story.title);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(
      page.getByTestId('library-card').filter({ hasText: story.title }),
    ).toHaveCount(0);

    guard.assertClean();
  });

  test('Scenario 2: Multi-photo upload (3 photos) + A4 landscape boy storybook (Franek, 7) + custom illustration swap + A4 PDF + library cleanup', async ({
    page,
    request,
  }) => {
    const guard = attachErrorGuards(page);
    activeTracker = createStoryTracker(page, request);
    await restoreDefaultSettings(request);

    await page.goto('/');
    const threePhotos = await getChildPhotosBatch(3);
    const { storyId } = await fillCreatorFormAndSubmit(page, {
      photos: threePhotos,
      childName: 'Franek',
      childAge: 7,
      gender: 'boy',
      companion: 'piesek Bąbel',
      theme: 'Podniebna wyprawa drewnianym sterowcem nad Tatrami',
      artStyle: 'storybook-gouache',
      mood: 'magical-adventure',
      pageCount: 10,
      provider: 'demo',
    });
    activeTracker.track(storyId);

    const story = await fetchStoryViaApi(request, storyId);
    expect(story.referencePhotos).toHaveLength(3);
    expect(story.input.gender).toBe('boy');

    // Verify framed child photo loads on Dedication slide
    await page.goto(`/story/${storyId}?slide=1`);
    await expectLoadedImage(page.getByTestId('dedication-photo'));

    // Replace illustration on Page 1 (?slide=2) with custom PNG
    await page.goto(`/story/${storyId}?slide=2`);
    const uploadPromise = page.waitForResponse(
      (res) =>
        res.request().method() === 'POST' &&
        res.url().includes(`/api/stories/${storyId}/illustrations/`),
      { timeout: 20_000 },
    );
    await uploadFilesToTestId(
      page,
      'replace-art-input',
      await getCustomIllustrationPng('page'),
    );
    expect((await uploadPromise).status()).toBe(200);

    await page.reload({ waitUntil: 'domcontentloaded' });
    const swappedImg = await expectLoadedImage(
      page.getByTestId('story-slide').locator('img').first(),
    );
    expect(swappedImg.src).toContain('/api/stories/');

    // Download A4 Landscape binary PDF
    const a4Pdf = await expectBinaryPdfDownload(
      page,
      async () => {
        await page.getByTestId('download-pdf-a4').click();
      },
      {
        expectedFormat: 'a4-landscape',
        expectedPageCount: 13,
        expectedTextSnippets: ['Fran'],
      },
    );
    expect(a4Pdf.bytes.length).toBeGreaterThan(20_480);

    // Clean up via /library
    await page.goto('/library');
    await deleteStoryFromLibrary(page, 'Franek');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(
      page.getByTestId('library-card').filter({ hasText: 'Franek' }),
    ).toHaveCount(0);

    guard.assertClean();
  });

  test('Scenario 3: Complete Manual Mode (Nano Banana) book assembly — English Character Bible prompt copy + custom cover & Page 1 upload + binary PDF', async ({
    page,
    request,
  }) => {
    await installClipboardSpy(page);
    const guard = attachErrorGuards(page);
    activeTracker = createStoryTracker(page, request);
    await restoreDefaultSettings(request);

    await page.goto('/');
    const { storyId } = await fillCreatorFormAndSubmit(page, {
      photos: [await getChildPhotoFixture(2)],
      childName: 'Basia',
      childAge: 6,
      gender: 'girl',
      companion: 'mały lisek Rudy',
      theme: 'Zimowa pracownia zabawek pod zorzą polarną',
      artStyle: 'paper-cutout',
      mood: 'warm-cozy',
      pageCount: 10,
      provider: 'manual',
    });
    activeTracker.track(storyId);

    // Copy English prompt on Cover (?slide=0) and upload custom cover illustration
    await page.goto(`/story/${storyId}?slide=0`);
    const coverPrompt = await readCopiedPromptAfterClick(page);
    expect(coverPrompt.length).toBeGreaterThanOrEqual(40);
    expect(coverPrompt).toMatch(/character|cover|illustration|style|storybook/i);

    const coverUploadPromise = page.waitForResponse(
      (res) =>
        res.request().method() === 'POST' &&
        res.url().includes(`/api/stories/${storyId}/illustrations/`),
      { timeout: 20_000 },
    );
    await uploadFilesToTestId(
      page,
      'replace-art-input',
      await getCustomIllustrationPng('cover'),
    );
    expect((await coverUploadPromise).status()).toBe(200);
    await expectLoadedImage(page.getByTestId('story-slide').locator('img').first());

    // Copy English prompt on Page 1 (?slide=2) and upload custom Page 1 illustration
    await page.goto(`/story/${storyId}?slide=2`);
    const pagePrompt = await readCopiedPromptAfterClick(page);
    expect(pagePrompt.length).toBeGreaterThanOrEqual(40);
    expect(pagePrompt).toMatch(/character|illustration|style|scene|storybook/i);

    const pageUploadPromise = page.waitForResponse(
      (res) =>
        res.request().method() === 'POST' &&
        res.url().includes(`/api/stories/${storyId}/illustrations/`),
      { timeout: 20_000 },
    );
    await uploadFilesToTestId(
      page,
      'replace-art-input',
      await getCustomIllustrationPng('page'),
    );
    expect((await pageUploadPromise).status()).toBe(200);

    // Reload and verify custom art persists
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expectLoadedImage(page.getByTestId('story-slide').locator('img').first());

    // Assemble and download binary 13-page Square PDF
    await expectBinaryPdfDownload(
      page,
      async () => {
        await page.getByTestId('download-pdf-square').click();
      },
      {
        expectedFormat: 'square',
        expectedPageCount: 13,
        expectedTextSnippets: ['Basi'],
      },
    );

    // Clean up via /library
    await page.goto('/library');
    await deleteStoryFromLibrary(page, 'Basia');

    guard.assertClean();
  });

  test('Scenario 4: Two concurrent stories in /library — switch between stories, download PDF from library, selectively delete one while keeping the other', async ({
    page,
    request,
  }) => {
    const guard = attachErrorGuards(page);
    activeTracker = createStoryTracker(page, request);
    await restoreDefaultSettings(request);

    const storyA = await createStoryViaApi(request, {
      childName: 'AmelkaA',
      childAge: 5,
      gender: 'girl',
      artStyle: 'watercolor',
      mood: 'warm-cozy',
      pageCount: 10,
      provider: 'demo',
      photos: [await getChildPhotoFixture(1)],
    });
    activeTracker.track(storyA.id);

    const storyB = await createStoryViaApi(request, {
      childName: 'KubaB',
      childAge: 8,
      gender: 'boy',
      artStyle: 'vintage-etching',
      mood: 'funny-playful',
      pageCount: 10,
      provider: 'demo',
      photos: [await getChildPhotoFixture(4)],
    });
    activeTracker.track(storyB.id);

    await page.goto('/library');
    const cardA = page
      .getByTestId('library-card')
      .filter({ hasText: 'AmelkaA' })
      .first();
    const cardB = page
      .getByTestId('library-card')
      .filter({ hasText: 'KubaB' })
      .first();

    await expect(cardA).toBeVisible();
    await expect(cardB).toBeVisible();
    await expectLoadedImage(cardA.locator('img').first());
    await expectLoadedImage(cardB.locator('img').first());

    // Open Story A from library
    await cardA.getByTestId('library-open-btn').click();
    await expect(page).toHaveURL(new RegExp(`/story/${storyA.id}(?:\\?|$)`));
    await expect(page.getByTestId('story-slide')).toContainText(storyA.title);

    // Switch to Story B via library
    await page.goto('/library');
    await cardB.getByTestId('library-open-btn').click();
    await expect(page).toHaveURL(new RegExp(`/story/${storyB.id}(?:\\?|$)`));
    await expect(page.getByTestId('story-slide')).toContainText(storyB.title);

    // Return to library and download binary PDF directly from Story B card
    await page.goto('/library');
    await expectBinaryPdfDownload(
      page,
      async () => {
        await cardB.getByTestId('library-pdf-btn').click();
      },
      {
        expectedPageCount: 13,
      },
    );

    // Delete Story A only; reload and confirm Story B remains intact
    await deleteStoryFromLibrary(page, 'AmelkaA');
    await page.reload({ waitUntil: 'domcontentloaded' });

    await expect(
      page.getByTestId('library-card').filter({ hasText: 'AmelkaA' }),
    ).toHaveCount(0);
    await expect(
      page.getByTestId('library-card').filter({ hasText: 'KubaB' }),
    ).toHaveCount(1);
    await expectLoadedImage(
      page
        .getByTestId('library-card')
        .filter({ hasText: 'KubaB' })
        .first()
        .locator('img')
        .first(),
    );

    // Delete Story B to finish cleanly
    await deleteStoryFromLibrary(page, 'KubaB');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(
      page.getByTestId('library-card').filter({ hasText: 'KubaB' }),
    ).toHaveCount(0);

    guard.assertClean();
  });

  test('Scenario 5: Fresh-context deep-link bookmarking (?slide=5 & ?view=all) and mobile 390×844 responsive audit with zero horizontal overflow', async ({
    browser,
    request,
    baseURL,
  }) => {
    const story = await createStoryViaApi(request, {
      childName: 'MilaDeep',
      childAge: 5,
      gender: 'girl',
      companion: 'srebrny zajączek',
      pageCount: 10,
      provider: 'demo',
    });

    const deepLinkContext = await browser.newContext({ baseURL });
    const mobileContext = await browser.newContext({
      baseURL,
      viewport: MOBILE_VIEWPORT,
    });

    try {
      // 1. Fresh-context deep-link bookmarking (no warm client cache)
      const deepPage = await deepLinkContext.newPage();
      const deepGuard = attachErrorGuards(deepPage);

      // ?slide=5 corresponds to Story Page 4 (story.pages[3])
      await expectSsrStoryRoute(request, deepPage, story.id, '?slide=5', {
        expectedTestId: 'story-slide',
        expectedTextSnippets: [story.pages[3].chapterTitle],
        expectedUrlPattern: new RegExp(`/story/${story.id}\\?.*slide=5`),
      });
      await expectLoadedImage(
        deepPage.getByTestId('story-slide').locator('img').first(),
      );

      await expectSsrStoryRoute(request, deepPage, story.id, '?view=all', {
        expectedTestId: 'all-pages-grid',
        expectedTextSnippets: [
          story.pages[0].chapterTitle,
          story.pages[9].chapterTitle,
        ],
        expectedUrlPattern: new RegExp(`/story/${story.id}\\?.*view=all`),
      });
      deepGuard.assertClean();

      // 2. Mobile viewport (390×844) responsive audit across every user route
      const mobilePage = await mobileContext.newPage();
      const mobileGuard = attachErrorGuards(mobilePage);

      const mobileRoutes = [
        '/',
        `/story/${story.id}?slide=0`,
        `/story/${story.id}?slide=1`,
        `/story/${story.id}?slide=2`,
        `/story/${story.id}?view=all`,
        '/library',
        '/settings',
      ];

      for (const route of mobileRoutes) {
        await mobilePage.goto(route, { waitUntil: 'networkidle' });
        await assertNoHorizontalOverflow(mobilePage, 1);
        await expectAllVisibleImagesLoaded(mobilePage);
      }

      mobileGuard.assertClean();
    } finally {
      await deepLinkContext.close();
      await mobileContext.close();
      const delRes = await request.delete(`/api/stories/${story.id}`);
      expect([200, 404]).toContain(delRes.status());
    }
  });
});
