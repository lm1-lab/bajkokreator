import { expect, test } from '@playwright/test';
import {
  getChildPhotoFixture,
  getChildPhotosBatch,
  getCustomIllustrationPng,
  getHighResPhotoFixture,
} from './fixtures/images';
import {
  ALL_ART_STYLES,
  ALL_STORY_MOODS,
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
  setPreviewFirst,
  uploadFilesToTestId,
  type StoryTracker,
} from './helpers';

test.describe('Tier 1 — Core BajkoKreator Features', () => {
  let activeTracker: StoryTracker | null = null;

  test.afterEach(async () => {
    if (activeTracker) {
      await activeTracker.cleanup();
      activeTracker = null;
    }
  });

  test('T1-01: Creator Studio loads editorial Vanilla CSS, updates live cover preview, inspirations, styles, moods, and 1–4 photo upload', async ({
    page,
    request,
  }) => {
    const guard = attachErrorGuards(page);
    activeTracker = createStoryTracker(page, request);
    await restoreDefaultSettings(request);

    await page.goto('/');
    await expect(page.getByTestId('live-cover-preview')).toBeVisible();
    await expect(page.getByTestId('cost-estimate')).toBeVisible();

    // Verify warm editorial Vanilla CSS styling loaded (not raw unstyled browser white)
    const bodyBg = await page.evaluate(
      () => window.getComputedStyle(document.body).backgroundColor,
    );
    expect(bodyBg).not.toBe('rgba(0, 0, 0, 0)');
    await expectAllVisibleImagesLoaded(page);

    // Clickable inspiration chips populate theme input
    const chips = page.getByTestId('inspiration-chip');
    expect(await chips.count()).toBeGreaterThanOrEqual(6);
    await chips.nth(0).click();
    const firstTheme = await page.getByTestId('theme-input').inputValue();
    expect(firstTheme.trim().length).toBeGreaterThan(5);

    await chips.nth(1).click();
    const secondTheme = await page.getByTestId('theme-input').inputValue();
    expect(secondTheme.trim().length).toBeGreaterThan(5);
    expect(secondTheme).not.toBe(firstTheme);

    // Live cover preview updates when child name & style change
    await page.getByTestId('child-name-input').fill('Kalina');
    await expect(page.getByTestId('live-cover-preview')).toContainText(
      /Kalin/i,
    );

    // All 4 graphic styles are visible and selectable
    for (const styleId of ALL_ART_STYLES) {
      const styleCard = page.getByTestId(`style-card-${styleId}`);
      await expect(styleCard).toBeVisible();
      await styleCard.click();
    }

    // All 4 story moods are visible and selectable
    for (const moodId of ALL_STORY_MOODS) {
      const moodPill = page.getByTestId(`mood-pill-${moodId}`);
      await expect(moodPill).toBeVisible();
      await moodPill.click();
    }

    // Preview-first toggle & cost estimator respond cleanly
    await setPreviewFirst(page, true);
    await expect(page.getByTestId('cost-estimate')).toBeVisible();
    await setPreviewFirst(page, false);

    // Upload 1 high-res photo (exercises client-side <canvas> compression) and a 4-photo batch
    const highResPhoto = await getHighResPhotoFixture();
    await uploadFilesToTestId(page, 'photo-input', highResPhoto);

    const fourPhotos = await getChildPhotosBatch(4);
    await uploadFilesToTestId(page, 'photo-input', fourPhotos);

    await expectAllVisibleImagesLoaded(page);
    guard.assertClean();
  });

  test('T1-02: Demo story creation end-to-end redirects to /story/[id] and persists story record', async ({
    page,
    request,
  }) => {
    const guard = attachErrorGuards(page);
    activeTracker = createStoryTracker(page, request);
    await restoreDefaultSettings(request);

    await page.goto('/');
    const photo = await getChildPhotoFixture(1);
    const { storyId } = await fillCreatorFormAndSubmit(page, {
      photos: [photo],
      childName: 'Zosia',
      childAge: 5,
      gender: 'girl',
      companion: 'rudy kotek Mruczek',
      theme: 'Magiczna wyprawa na łąkę pełną świetlików',
      artStyle: 'watercolor',
      mood: 'warm-cozy',
      pageCount: 10,
      provider: 'demo',
    });

    const story = await fetchStoryViaApi(request, storyId);
    expect(story.provider).toBe('demo');
    expect(story.input.childName).toBe('Zosia');
    expect(story.input.gender).toBe('girl');
    expect(story.pages).toHaveLength(10);
    expect(story.referencePhotos.length).toBeGreaterThanOrEqual(1);

    await expectLoadedImage(page.getByTestId('story-slide').locator('img').first());
    guard.assertClean();
  });

  test('T1-03: Story viewer navigates Cover (0), Dedication (1) with child photo, Pages 1–10 (2..11), and Back Cover (12)', async ({
    page,
    request,
  }) => {
    const guard = attachErrorGuards(page);
    activeTracker = createStoryTracker(page, request);

    const story = await createStoryViaApi(request, {
      childName: 'Hania',
      childAge: 6,
      gender: 'girl',
      companion: 'mały jeżyk Igiełka',
      pageCount: 10,
      provider: 'demo',
    });
    activeTracker.track(story.id);

    await page.goto(`/story/${story.id}?slide=0`);
    await expect(page.getByTestId('story-slide')).toBeVisible();
    await expect(page.getByTestId('story-slide')).toContainText(story.title);
    await expectLoadedImage(page.getByTestId('story-slide').locator('img').first());

    const coverIndicator = await page.getByTestId('slide-indicator').innerText();
    expect(coverIndicator.trim().length).toBeGreaterThan(0);

    // Slide 1: Dedication with framed child photo
    await page.getByTestId('slide-next').click();
    await expect(page).toHaveURL(new RegExp(`/story/${story.id}\\?.*slide=1`));
    await expectLoadedImage(page.getByTestId('dedication-photo'));
    await expect(page.getByTestId('story-slide')).toContainText(
      story.dedicationText.slice(0, 24),
    );

    // Slides 2..11: Story Pages 1..10
    for (let slideIndex = 2; slideIndex <= 11; slideIndex += 1) {
      await page.getByTestId('slide-next').click();
      await expect(page).toHaveURL(
        new RegExp(`/story/${story.id}\\?.*slide=${slideIndex}(?:&|$)`),
      );
      const expectedPage = story.pages[slideIndex - 2];
      await expect(page.getByTestId('story-slide')).toContainText(
        expectedPage.text.slice(0, 28),
      );
      await expectLoadedImage(
        page.getByTestId('story-slide').locator('img').first(),
      );
    }

    // Slide 12: Back Cover
    await page.getByTestId('slide-next').click();
    await expect(page).toHaveURL(new RegExp(`/story/${story.id}\\?.*slide=12`));
    await expect(page.getByTestId('story-slide')).toContainText(
      story.backCoverBlurb.slice(0, 24),
    );

    // Step backward with slide-prev
    await page.getByTestId('slide-prev').click();
    await expect(page).toHaveURL(new RegExp(`/story/${story.id}\\?.*slide=11`));
    await expect(page.getByTestId('story-slide')).toContainText(
      story.pages[9].text.slice(0, 28),
    );

    guard.assertClean();
  });

  test('T1-04: Direct URL navigation (?slide=3 and ?view=all) renders via SSR without Suspense flicker and view-all toggle works', async ({
    page,
    request,
  }) => {
    const guard = attachErrorGuards(page);
    activeTracker = createStoryTracker(page, request);

    const story = await createStoryViaApi(request, {
      childName: 'Maja',
      childAge: 5,
      gender: 'girl',
      pageCount: 10,
      provider: 'demo',
    });
    activeTracker.track(story.id);

    // Direct SSR check on ?slide=3 (Story Page 2 => pages[1])
    await expectSsrStoryRoute(request, page, story.id, '?slide=3', {
      expectedTestId: 'story-slide',
      expectedTextSnippets: [story.pages[1].chapterTitle],
      expectedUrlPattern: new RegExp(`/story/${story.id}\\?.*slide=3`),
    });

    // Direct SSR check on ?view=all
    await expectSsrStoryRoute(request, page, story.id, '?view=all', {
      expectedTestId: 'all-pages-grid',
      expectedTextSnippets: [
        story.pages[0].chapterTitle,
        story.pages[9].chapterTitle,
      ],
      expectedUrlPattern: new RegExp(`/story/${story.id}\\?.*view=all`),
    });

    // Toggle back to single slide view and back to all-pages view
    await page.getByTestId('view-all-toggle').click();
    await expect(page.getByTestId('story-slide')).toBeVisible();

    await page.getByTestId('view-all-toggle').click();
    await expect(page).toHaveURL(new RegExp(`/story/${story.id}\\?.*view=all`));
    await expect(page.getByTestId('all-pages-grid')).toBeVisible();

    guard.assertClean();
  });

  test('T1-05: Inline text editing with Polish diacritics persists across full page reload', async ({
    page,
    request,
  }) => {
    const guard = attachErrorGuards(page);
    activeTracker = createStoryTracker(page, request);

    const story = await createStoryViaApi(request, {
      childName: 'Łucja',
      childAge: 5,
      gender: 'girl',
      pageCount: 10,
      provider: 'demo',
    });
    activeTracker.track(story.id);

    const editedText =
      'Zażółć gęślą jaźń — Łucja odkryła lśniącą ścieżkę wśród złotych liści.';

    await page.goto(`/story/${story.id}?slide=2`);
    await expect(page.getByTestId('edit-text-btn')).toBeVisible();
    await page.getByTestId('edit-text-btn').click();

    const textArea = page.getByTestId('edit-text-area');
    await expect(textArea).toBeVisible();
    await textArea.fill(editedText);

    const patchPromise = page.waitForResponse(
      (res) =>
        res.request().method() === 'PATCH' &&
        res.url().includes(`/api/stories/${story.id}/pages/1`),
      { timeout: 15_000 },
    );
    await page.getByTestId('save-text-btn').click();
    const patchRes = await patchPromise;
    expect(patchRes.status()).toBe(200);

    await expect(page.getByTestId('story-slide')).toContainText(editedText);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('story-slide')).toContainText(editedText);

    const refreshed = await fetchStoryViaApi(request, story.id);
    expect(refreshed.pages[0].text).toBe(editedText);

    guard.assertClean();
  });

  test('T1-06: Nano Banana prompt copy button and custom illustration replacement persist across reload', async ({
    page,
    request,
  }) => {
    await installClipboardSpy(page);
    const guard = attachErrorGuards(page);
    activeTracker = createStoryTracker(page, request);

    const story = await createStoryViaApi(request, {
      childName: 'Staś',
      childAge: 6,
      gender: 'boy',
      pageCount: 10,
      provider: 'demo',
    });
    activeTracker.track(story.id);

    await page.goto(`/story/${story.id}?slide=2`);
    await expect(page.getByTestId('story-slide')).toBeVisible();

    const copiedPrompt = await readCopiedPromptAfterClick(page);
    expect(copiedPrompt.length).toBeGreaterThanOrEqual(40);
    expect(copiedPrompt).toMatch(
      /character|illustration|style|storybook|scene|lighting|palette|watercolor/i,
    );

    // Replace Page 1 illustration with authentic PNG file
    const customPng = await getCustomIllustrationPng('page');
    const uploadResponsePromise = page.waitForResponse(
      (res) =>
        res.request().method() === 'POST' &&
        res.url().includes(`/api/stories/${story.id}/illustrations/`),
      { timeout: 20_000 },
    );
    await uploadFilesToTestId(page, 'replace-art-input', customPng);
    const uploadRes = await uploadResponsePromise;
    expect(uploadRes.status()).toBe(200);

    const uploadedJson = (await uploadRes.json()) as {
      filename: string;
      assetUrl: string;
    };
    expect(uploadedJson.filename).toMatch(/\.(png|jpg|jpeg|webp)$/i);

    const afterUploadImg = await expectLoadedImage(
      page.getByTestId('story-slide').locator('img').first(),
    );
    expect(afterUploadImg.src).toContain('/api/stories/');

    await page.reload({ waitUntil: 'domcontentloaded' });
    const afterReloadImg = await expectLoadedImage(
      page.getByTestId('story-slide').locator('img').first(),
    );
    expect(afterReloadImg.src).toContain('/api/stories/');

    const refreshed = await fetchStoryViaApi(request, story.id);
    expect(refreshed.pages[0].imageStatus).toBe('custom-uploaded');
    expect(refreshed.pages[0].imageFilename).toBeTruthy();

    guard.assertClean();
  });

  test('T1-07: Binary PDF download works for Square 21×21 cm and A4 Landscape with 13 pages, valid headers, Polish text, and no raw %PDF- in DOM', async ({
    page,
    request,
  }) => {
    const guard = attachErrorGuards(page);
    activeTracker = createStoryTracker(page, request);

    const story = await createStoryViaApi(request, {
      childName: 'Zosia',
      childAge: 5,
      gender: 'girl',
      companion: 'rudy kotek Mruczek',
      pageCount: 10,
      provider: 'demo',
    });
    activeTracker.track(story.id);

    await page.goto(`/story/${story.id}?slide=0`);
    await expect(page.getByTestId('download-pdf-square')).toBeVisible();
    await expect(page.getByTestId('download-pdf-a4')).toBeVisible();

    const squarePdf = await expectBinaryPdfDownload(
      page,
      async () => {
        await page.getByTestId('download-pdf-square').click();
      },
      {
        expectedFormat: 'square',
        expectedPageCount: 13,
        expectedTextSnippets: ['Zosi'],
      },
    );
    expect(squarePdf.bytes.length).toBeGreaterThan(20_480);

    const a4Pdf = await expectBinaryPdfDownload(
      page,
      async () => {
        await page.getByTestId('download-pdf-a4').click();
      },
      {
        expectedFormat: 'a4-landscape',
        expectedPageCount: 13,
        expectedTextSnippets: ['Zosi'],
      },
    );
    expect(a4Pdf.bytes.length).toBeGreaterThan(20_480);

    guard.assertClean();
  });

  test('T1-08: /library lists saved story with cover, opens story, downloads binary PDF, and executes 2-step delete persisting after reload', async ({
    page,
    request,
  }) => {
    const guard = attachErrorGuards(page);
    activeTracker = createStoryTracker(page, request);

    const uniqueName = 'CelinkaLib';
    const story = await createStoryViaApi(request, {
      childName: uniqueName,
      childAge: 6,
      gender: 'girl',
      pageCount: 10,
      provider: 'demo',
    });
    activeTracker.track(story.id);

    await page.goto('/library');
    await expect(page.getByTestId('library-grid')).toBeVisible();

    const card = page
      .getByTestId('library-card')
      .filter({ hasText: uniqueName })
      .first();
    await expect(card).toBeVisible();
    await expectLoadedImage(card.locator('img').first());

    // Download binary PDF directly from library card
    await expectBinaryPdfDownload(
      page,
      async () => {
        await card.getByTestId('library-pdf-btn').click();
      },
      {
        expectedPageCount: 13,
      },
    );

    // Open story from library card
    await card.getByTestId('library-open-btn').click();
    await expect(page).toHaveURL(new RegExp(`/story/${story.id}(?:\\?|$)`));
    await expect(page.getByTestId('story-slide')).toBeVisible();

    // Return to /library and delete via 2-step confirmation
    await page.goto('/library');
    await deleteStoryFromLibrary(page, uniqueName);

    // Verify deletion persists across reload and API returns 404
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(
      page.getByTestId('library-card').filter({ hasText: uniqueName }),
    ).toHaveCount(0);

    const checkDeleted = await request.get(`/api/stories/${story.id}`);
    expect(checkDeleted.status()).toBe(404);

    guard.assertClean();
  });

  test('T1-09: /settings displays provider selector, daily quota, cost table, storage mode, Dec 2026 subscription section, and zero exposed secrets', async ({
    page,
    request,
  }) => {
    const guard = attachErrorGuards(page);
    activeTracker = createStoryTracker(page, request);

    await page.goto('/settings');
    await expect(page.getByTestId('settings-provider-select')).toBeVisible();
    await expect(page.getByTestId('settings-save-btn')).toBeVisible();
    await expect(page.getByTestId('quota-status')).toBeVisible();
    await expect(page.getByTestId('storage-mode-badge')).toBeVisible();
    await expect(page.getByTestId('subscription-adapter-section')).toBeVisible();

    // Daily quota displays limit (default 30)
    await expect(page.getByTestId('quota-status')).toContainText(/30/);

    // Storage mode indicates local or tmp-fallback
    await expect(page.getByTestId('storage-mode-badge')).toContainText(
      /local|tmp|dysk|tymczas/i,
    );

    // ~2 grudnia 2026 google-subscription section is documented clearly
    await expect(page.getByTestId('subscription-adapter-section')).toContainText(
      /2026|grudni|google-subscription|subskrypc/i,
    );

    // Cost table / estimator info is visible on settings page
    await expect(page.locator('body')).toContainText(/koszt|cost|demo/i);

    // Verify GET /api/settings never leaks raw API secrets/tokens
    const settingsRes = await request.get('/api/settings');
    expect(settingsRes.status()).toBe(200);
    const rawSettingsText = await settingsRes.text();
    expect(rawSettingsText).not.toMatch(/AIza[0-9A-Za-z_-]{20,}/);
    expect(rawSettingsText).not.toMatch(/ya29\.[0-9A-Za-z._-]{20,}/);

    guard.assertClean();
  });
});
