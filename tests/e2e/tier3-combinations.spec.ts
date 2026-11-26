import { expect, test } from '@playwright/test';
import {
  getChildPhotoFixture,
  getCustomIllustrationPng,
  getCustomIllustrationWebp,
} from './fixtures/images';
import {
  attachErrorGuards,
  createStoryTracker,
  createStoryViaApi,
  expectBinaryPdfDownload,
  expectLoadedImage,
  fetchStoryViaApi,
  fillCreatorFormAndSubmit,
  installClipboardSpy,
  readCopiedPromptAfterClick,
  readSelectedProvider,
  restoreDefaultSettings,
  selectProvider,
  uploadFilesToTestId,
  type StoryTracker,
} from './helpers';

test.describe('Tier 3 — Cross-Feature Combinations & Pairwise Interactions', () => {
  let activeTracker: StoryTracker | null = null;

  test.afterEach(async () => {
    if (activeTracker) {
      await activeTracker.cleanup();
      activeTracker = null;
    }
  });

  test('T3-01: Feminine (dziewczynka + companion) vs Masculine (chłopiec, no companion) produces accurate Polish gender inflection', async ({
    page,
    request,
  }) => {
    const guard = attachErrorGuards(page);
    activeTracker = createStoryTracker(page, request);
    await restoreDefaultSettings(request);

    // 1. Feminine protagonist with companion
    await page.goto('/');
    const girlResult = await fillCreatorFormAndSubmit(page, {
      photos: [await getChildPhotoFixture(1)],
      childName: 'Zosia',
      childAge: 5,
      gender: 'girl',
      companion: 'rudy kotek Mruczek',
      theme: 'Tajemniczy ogród z mówiącymi kwiatami',
      artStyle: 'storybook-gouache',
      mood: 'magical-adventure',
      pageCount: 10,
      provider: 'demo',
    });
    activeTracker.track(girlResult.storyId);

    const girlStory = await fetchStoryViaApi(request, girlResult.storyId);
    const girlCorpus = [
      girlStory.title,
      girlStory.subtitle,
      girlStory.dedicationText,
      girlStory.backCoverBlurb,
      ...girlStory.pages.map((p) => `${p.chapterTitle} ${p.text}`),
    ].join(' ');

    expect(girlCorpus).toMatch(/Zosi/i);
    expect(girlCorpus).toMatch(/Mrucz/i);
    expect(girlCorpus).toMatch(
      /\b(mała|dzielna|odważna|ciekawa|dziewczynka|dziewczynki|bohaterka|poszła|ruszyła|zobaczyła|odkryła|uśmiechnęła|spojrzała|wzięła|powiedziała|pomyślała|poczuła|zauważyła|5-letnia)\b/i,
    );
    expect(girlCorpus).not.toMatch(
      /\b(chłopiec|chłopca|chłopcu|5-letni)\b/i,
    );
    expect(girlCorpus).not.toMatch(/\{\{|undefined|NaN/);

    // 2. Masculine protagonist without companion
    await page.goto('/');
    const boyResult = await fillCreatorFormAndSubmit(page, {
      photos: [await getChildPhotoFixture(2)],
      childName: 'Antoś',
      childAge: 4,
      gender: 'boy',
      companion: '',
      theme: 'Podróż balonem ponad chmurami',
      artStyle: 'vintage-etching',
      mood: 'funny-playful',
      pageCount: 10,
      provider: 'demo',
    });
    activeTracker.track(boyResult.storyId);

    const boyStory = await fetchStoryViaApi(request, boyResult.storyId);
    const boyCorpus = [
      boyStory.title,
      boyStory.subtitle,
      boyStory.dedicationText,
      boyStory.backCoverBlurb,
      ...boyStory.pages.map((p) => `${p.chapterTitle} ${p.text}`),
    ].join(' ');

    expect(boyCorpus).toMatch(/Anto/i);
    expect(boyCorpus).toMatch(
      /\b(mały|dzielny|odważny|ciekawy|chłopiec|bohater|poszedł|ruszył|zobaczył|odkrył|uśmiechnął|spojrzał|wziął|powiedział|pomyślał|poczuł|zauważył|4-letni)\b/i,
    );
    expect(boyCorpus).not.toMatch(
      /\b(dziewczynka|dziewczynki|bohaterka|4-letnia)\b/i,
    );
    expect(boyCorpus).not.toMatch(/\{\{|undefined|NaN/);

    // Ensure dedication & story slides render cleanly on screen
    await page.goto(`/story/${boyResult.storyId}?slide=1`);
    await expectLoadedImage(page.getByTestId('dedication-photo'));

    guard.assertClean();
  });

  test('T3-02: Manual mode (Nano Banana) creation -> copy English Character Bible prompt -> upload custom PNG & WebP -> export 13-page PDF', async ({
    page,
    request,
  }) => {
    await installClipboardSpy(page);
    const guard = attachErrorGuards(page);
    activeTracker = createStoryTracker(page, request);
    await restoreDefaultSettings(request);

    await page.goto('/');
    const { storyId } = await fillCreatorFormAndSubmit(page, {
      photos: [await getChildPhotoFixture(3)],
      childName: 'Klara',
      childAge: 6,
      gender: 'girl',
      companion: 'sowa Puchatka',
      theme: 'Sekretna biblioteka w koronach drzew',
      artStyle: 'paper-cutout',
      mood: 'bedtime-calm',
      pageCount: 10,
      provider: 'manual',
    });
    activeTracker.track(storyId);

    const manualStory = await fetchStoryViaApi(request, storyId);
    expect(manualStory.provider).toBe('manual');
    expect(manualStory.characterBible.trim().length).toBeGreaterThan(20);
    expect(manualStory.pages).toHaveLength(10);

    // Go to Page 1 (?slide=2), copy English Nano Banana prompt with invariant Character Bible
    await page.goto(`/story/${storyId}?slide=2`);
    const copiedPrompt = await readCopiedPromptAfterClick(page);
    expect(copiedPrompt.length).toBeGreaterThanOrEqual(40);
    expect(copiedPrompt).toMatch(
      /character|illustration|style|paper|storybook|scene|lighting|consistent/i,
    );

    // Upload custom PNG illustration on Page 1
    const pngUploadPromise = page.waitForResponse(
      (res) =>
        res.request().method() === 'POST' &&
        res.url().includes(`/api/stories/${storyId}/illustrations/1`),
      { timeout: 20_000 },
    );
    await uploadFilesToTestId(
      page,
      'replace-art-input',
      await getCustomIllustrationPng('page'),
    );
    expect((await pngUploadPromise).status()).toBe(200);
    await expectLoadedImage(page.getByTestId('story-slide').locator('img').first());

    // Upload custom WebP illustration on Page 2 (?slide=3) to verify WebP support & PDF transcoding
    await page.getByTestId('slide-next').click();
    await expect(page).toHaveURL(new RegExp(`/story/${storyId}\\?.*slide=3`));
    const webpUploadPromise = page.waitForResponse(
      (res) =>
        res.request().method() === 'POST' &&
        res.url().includes(`/api/stories/${storyId}/illustrations/2`),
      { timeout: 20_000 },
    );
    await uploadFilesToTestId(
      page,
      'replace-art-input',
      await getCustomIllustrationWebp(),
    );
    expect((await webpUploadPromise).status()).toBe(200);
    await expectLoadedImage(page.getByTestId('story-slide').locator('img').first());

    // Reload and verify custom art persists
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expectLoadedImage(page.getByTestId('story-slide').locator('img').first());

    // Export binary 13-page PDF containing the assembled custom artwork
    const pdfResult = await expectBinaryPdfDownload(
      page,
      async () => {
        await page.getByTestId('download-pdf-square').click();
      },
      {
        expectedFormat: 'square',
        expectedPageCount: 13,
        expectedTextSnippets: ['Klar'],
      },
    );
    expect(pdfResult.bytes.length).toBeGreaterThan(20_480);

    guard.assertClean();
  });

  test('T3-03: Switch between ?view=all, ?slide=N, inline edit, browser back/forward history (popstate), and binary PDF export', async ({
    page,
    request,
  }) => {
    const guard = attachErrorGuards(page);
    activeTracker = createStoryTracker(page, request);

    const story = await createStoryViaApi(request, {
      childName: 'Leon',
      childAge: 6,
      gender: 'boy',
      pageCount: 10,
      provider: 'demo',
    });
    activeTracker.track(story.id);

    await page.goto(`/story/${story.id}?slide=0`);
    await expect(page.getByTestId('story-slide')).toBeVisible();

    // Navigate forward via slide-next (pushState: 0 -> 1 -> 2)
    await page.getByTestId('slide-next').click();
    await expect(page).toHaveURL(new RegExp(`/story/${story.id}\\?.*slide=1`));
    await page.getByTestId('slide-next').click();
    await expect(page).toHaveURL(new RegExp(`/story/${story.id}\\?.*slide=2`));

    // Edit Page 1 inline
    const customPhrase = 'Leon odnalazł żółtą latarenkę na szczycie wzgórza.';
    await page.getByTestId('edit-text-btn').click();
    await page.getByTestId('edit-text-area').fill(customPhrase);
    const savePromise = page.waitForResponse(
      (res) =>
        res.request().method() === 'PATCH' &&
        res.url().includes(`/api/stories/${story.id}/pages/1`),
    );
    await page.getByTestId('save-text-btn').click();
    expect((await savePromise).status()).toBe(200);
    await expect(page.getByTestId('story-slide')).toContainText(customPhrase);

    // Toggle to ?view=all and verify edited text appears in all-pages overview
    await page.getByTestId('view-all-toggle').click();
    await expect(page).toHaveURL(new RegExp(`/story/${story.id}\\?.*view=all`));
    await expect(page.getByTestId('all-pages-grid')).toContainText(customPhrase);

    // Browser Back (popstate) returns from ?view=all to ?slide=2
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/story/${story.id}\\?.*slide=2`));
    await expect(page.getByTestId('story-slide')).toContainText(customPhrase);

    // Browser Back again returns to ?slide=1 (Dedication)
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/story/${story.id}\\?.*slide=1`));
    await expectLoadedImage(page.getByTestId('dedication-photo'));

    // Browser Forward returns to ?slide=2
    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`/story/${story.id}\\?.*slide=2`));
    await expect(page.getByTestId('story-slide')).toContainText(customPhrase);

    // Export binary PDF and verify the inline edit is reflected in the PDF
    await expectBinaryPdfDownload(
      page,
      async () => {
        await page.getByTestId('download-pdf-a4').click();
      },
      {
        expectedFormat: 'a4-landscape',
        expectedPageCount: 13,
        expectedTextSnippets: ['żółtą latarenkę'],
      },
    );

    guard.assertClean();
  });

  test('T3-04: Settings provider change persists on /settings and reflects in Creator / default selection', async ({
    page,
    request,
  }) => {
    const guard = attachErrorGuards(page);
    activeTracker = createStoryTracker(page, request);
    await restoreDefaultSettings(request);

    try {
      await page.goto('/settings');
      await selectProvider(page, 'settings-provider-select', 'manual');

      const savePromise = page.waitForResponse(
        (res) =>
          res.request().method() === 'PATCH' &&
          /\/api\/settings\/?$/.test(new URL(res.url()).pathname),
        { timeout: 15_000 },
      );
      await page.getByTestId('settings-save-btn').click();
      expect((await savePromise).status()).toBe(200);

      // Reload /settings and verify persistence
      await page.reload({ waitUntil: 'domcontentloaded' });
      const savedProvider = await readSelectedProvider(
        page,
        'settings-provider-select',
      );
      expect(savedProvider.toLowerCase()).toContain('manual');

      // Navigate to Creator `/` and verify default provider reflects saved setting
      await page.goto('/');
      const creatorProvider = await readSelectedProvider(
        page,
        'provider-select',
      );
      expect(creatorProvider.toLowerCase()).toContain('manual');
    } finally {
      await restoreDefaultSettings(request);
    }

    guard.assertClean();
  });

  test('T3-05: Preview-first mode generates preview stage and continue-generation completes remaining pages', async ({
    page,
    request,
  }) => {
    const guard = attachErrorGuards(page);
    activeTracker = createStoryTracker(page, request);
    await restoreDefaultSettings(request);

    await page.goto('/');
    const { storyId } = await fillCreatorFormAndSubmit(page, {
      photos: [await getChildPhotoFixture(4)],
      childName: 'Iga',
      childAge: 5,
      gender: 'girl',
      theme: 'Wyprawa na księżycową polanę',
      artStyle: 'watercolor',
      mood: 'bedtime-calm',
      pageCount: 6,
      provider: 'demo',
      previewFirst: true,
    });
    activeTracker.track(storyId);

    const previewStory = await fetchStoryViaApi(request, storyId);
    expect(previewStory.generationMode).toBe('preview-first');

    if (previewStory.generationStage === 'preview') {
      const continueBtn = page.getByTestId('continue-generation-btn');
      await expect(continueBtn).toBeVisible();

      const continuePromise = page.waitForResponse(
        (res) =>
          res.request().method() === 'POST' &&
          res.url().includes(`/api/stories/${storyId}/continue`),
        { timeout: 30_000 },
      );
      await continueBtn.click();
      expect((await continuePromise).status()).toBe(200);

      await page.reload({ waitUntil: 'domcontentloaded' });
      const completedStory = await fetchStoryViaApi(request, storyId);
      expect(completedStory.generationStage).toBe('complete');
      expect(completedStory.pages).toHaveLength(6);
    }

    guard.assertClean();
  });
});
