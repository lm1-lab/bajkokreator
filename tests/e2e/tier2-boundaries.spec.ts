import { expect, test, type APIRequestContext } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import {
  getChildPhotoFixture,
  getChildPhotosBatch,
  getCorruptedJpegFixture,
  getInvalidTextFileFixture,
  getSpoofedJpegFixture,
  type E2EFilePayload,
} from './fixtures/images';
import {
  attachErrorGuards,
  cleanupAllStories,
  createStoryTracker,
  createStoryViaApi,
  expectBinaryPdfDownload,
  expectPdfApiHeaders,
  restoreDefaultSettings,
  uploadFilesToTestId,
  type StoryTracker,
} from './helpers';

async function postRawStoryMultipart(
  request: APIRequestContext,
  payload: Record<string, unknown>,
  photos: E2EFilePayload[],
) {
  const form = new FormData();
  form.append('payload', JSON.stringify(payload));
  for (const photo of photos) {
    form.append(
      'photos',
      new Blob([new Uint8Array(photo.buffer)], { type: photo.mimeType }),
      photo.name,
    );
  }
  return request.post('/api/stories', { multipart: form });
}

test.describe('Tier 2 — Boundaries, Validation, Security & Edge States', () => {
  let activeTracker: StoryTracker | null = null;

  test.afterEach(async () => {
    if (activeTracker) {
      await activeTracker.cleanup();
      activeTracker = null;
    }
  });

  test('T2-01: Creator UI & API reject invalid/out-of-range inputs and accept exact min/max boundaries', async ({
    page,
    request,
  }) => {
    const guard = attachErrorGuards(page);
    activeTracker = createStoryTracker(page, request);
    await restoreDefaultSettings(request);

    // UI negative check: empty name & 0 photos stay safely on `/` without crash
    await page.goto('/');
    await page.getByTestId('child-name-input').fill('');
    await page.getByTestId('create-story-submit').click();
    await expect(page).toHaveURL(/\/(?:\?.*)?$/);

    // UI negative check: non-image text file upload is rejected gracefully without pageerror
    guard.allowExpectedHttpError({
      status: 400,
      urlPattern: /\/api\/stories/,
    });
    await uploadFilesToTestId(page, 'photo-input', getInvalidTextFileFixture());
    await expect(page).toHaveURL(/\/(?:\?.*)?$/);

    // API negative validation probes (all must return 400/422, never 201 or 500)
    const validPhoto = await getChildPhotoFixture(1);
    const basePayload = {
      childName: 'Ola',
      childAge: 5,
      gender: 'girl',
      theme: 'Wyprawa na zaczarowaną wyspę',
      artStyle: 'watercolor',
      mood: 'warm-cozy',
      pageCount: 10,
      provider: 'demo',
      bookFormat: 'square',
      generationMode: 'full',
    };

    const invalidCases: Array<{
      label: string;
      payload: Record<string, unknown>;
      photos: E2EFilePayload[];
    }> = [
      {
        label: 'empty childName',
        payload: { ...basePayload, childName: '   ' },
        photos: [validPhoto],
      },
      {
        label: 'childAge below min (0)',
        payload: { ...basePayload, childAge: 0 },
        photos: [validPhoto],
      },
      {
        label: 'childAge above max (13)',
        payload: { ...basePayload, childAge: 13 },
        photos: [validPhoto],
      },
      {
        label: 'pageCount below min (3)',
        payload: { ...basePayload, pageCount: 3 },
        photos: [validPhoto],
      },
      {
        label: 'pageCount above max (13)',
        payload: { ...basePayload, pageCount: 13 },
        photos: [validPhoto],
      },
      {
        label: '0 photos uploaded',
        payload: basePayload,
        photos: [],
      },
      {
        label: '5 photos uploaded (>4 max)',
        payload: basePayload,
        photos: await getChildPhotosBatch(5),
      },
      {
        label: 'plain text file masquerading as photo',
        payload: basePayload,
        photos: [getInvalidTextFileFixture()],
      },
      {
        label: 'spoofed JPEG without FF D8 FF magic bytes',
        payload: basePayload,
        photos: [getSpoofedJpegFixture()],
      },
    ];

    for (const testCase of invalidCases) {
      const res = await postRawStoryMultipart(
        request,
        testCase.payload,
        testCase.photos,
      );
      expect(
        [400, 422],
        `Expected 400/422 for "${testCase.label}", got ${res.status()}`,
      ).toContain(res.status());
    }

    // Valid min boundary: age 1, pageCount 4 -> 7 PDF pages
    const minStory = await createStoryViaApi(request, {
      childName: 'Ada',
      childAge: 1,
      gender: 'girl',
      pageCount: 4,
      provider: 'demo',
    });
    activeTracker.track(minStory.id);
    expect(minStory.pages).toHaveLength(4);

    const minPdfRes = await request.get(
      `/api/stories/${minStory.id}/pdf?format=square`,
    );
    expect(minPdfRes.status()).toBe(200);
    expectPdfApiHeaders(minPdfRes.headers());
    const minPdfDoc = await PDFDocument.load(await minPdfRes.body());
    expect(minPdfDoc.getPageCount()).toBe(7);

    // Valid max boundary: age 12, pageCount 12 -> 15 PDF pages
    const maxStory = await createStoryViaApi(request, {
      childName: 'Błażej',
      childAge: 12,
      gender: 'boy',
      pageCount: 12,
      provider: 'demo',
      photos: await getChildPhotosBatch(4),
    });
    activeTracker.track(maxStory.id);
    expect(maxStory.pages).toHaveLength(12);
    expect(maxStory.referencePhotos).toHaveLength(4);

    const maxPdfRes = await request.get(
      `/api/stories/${maxStory.id}/pdf?format=a4-landscape`,
    );
    expect(maxPdfRes.status()).toBe(200);
    expectPdfApiHeaders(maxPdfRes.headers());
    const maxPdfDoc = await PDFDocument.load(await maxPdfRes.body());
    expect(maxPdfDoc.getPageCount()).toBe(15);

    guard.assertClean();
  });

  test('T2-02: Path traversal, invalid story IDs, invalid assets/slots/formats, and nosniff headers are strictly enforced', async ({
    page,
    request,
  }) => {
    const guard = attachErrorGuards(page);
    activeTracker = createStoryTracker(page, request);

    const story = await createStoryViaApi(request, {
      childName: 'Tomek',
      childAge: 6,
      gender: 'boy',
      pageCount: 6,
      provider: 'demo',
    });
    activeTracker.track(story.id);

    // Path traversal & invalid story IDs
    const storyProbes = [
      '/api/stories/..%2Fetc%2Fpasswd',
      '/api/stories/..%5Cstory.json',
      '/api/stories/BAD_UPPERCASE_ID!',
      '/api/stories/nonexistent-story-id-9999',
    ];
    for (const url of storyProbes) {
      const res = await request.get(url);
      expect(
        [400, 404],
        `Expected 400/404 for GET ${url}, got ${res.status()}`,
      ).toContain(res.status());
    }

    const delMissing = await request.delete(
      '/api/stories/nonexistent-story-id-9999',
    );
    expect([400, 404]).toContain(delMissing.status());

    // Asset traversal & disallowed filename probes
    const assetProbes = [
      `/api/stories/${story.id}/assets/..%2Fstory.json`,
      `/api/stories/${story.id}/assets/..%2F..%2Fpackage.json`,
      `/api/stories/${story.id}/assets/story.json`,
      `/api/stories/${story.id}/assets/missing-file.jpg`,
    ];
    for (const url of assetProbes) {
      const res = await request.get(url);
      expect(
        [400, 404],
        `Expected 400/404 for GET ${url}, got ${res.status()}`,
      ).toContain(res.status());
    }

    // Valid reference photo asset returns 200 + X-Content-Type-Options: nosniff
    const validAssetRes = await request.get(
      `/api/stories/${story.id}/assets/${story.referencePhotos[0]}`,
    );
    expect(validAssetRes.status()).toBe(200);
    expect(validAssetRes.headers()['x-content-type-options']?.toLowerCase()).toBe(
      'nosniff',
    );
    const assetBytes = await validAssetRes.body();
    expect(assetBytes.length).toBeGreaterThan(500);

    // Invalid illustration slot & non-image / spoofed uploads
    const spoofForm = new FormData();
    const spoofed = getSpoofedJpegFixture();
    spoofForm.append(
      'file',
      new Blob([new Uint8Array(spoofed.buffer)], { type: spoofed.mimeType }),
      spoofed.name,
    );
    const spoofRes = await request.post(
      `/api/stories/${story.id}/illustrations/1`,
      { multipart: spoofForm },
    );
    expect([400, 422]).toContain(spoofRes.status());

    const invalidSlotForm = new FormData();
    const validPhoto = await getChildPhotoFixture(2);
    invalidSlotForm.append(
      'file',
      new Blob([new Uint8Array(validPhoto.buffer)], {
        type: validPhoto.mimeType,
      }),
      validPhoto.name,
    );
    const badSlotRes = await request.post(
      `/api/stories/${story.id}/illustrations/99`,
      { multipart: invalidSlotForm },
    );
    expect([400, 404]).toContain(badSlotRes.status());

    const traversalSlotRes = await request.post(
      `/api/stories/${story.id}/illustrations/..%2Fevil`,
      { multipart: invalidSlotForm },
    );
    expect([400, 404]).toContain(traversalSlotRes.status());

    // Corrupted JPEG check on story creation or illustration upload must not 500
    const corruptForm = new FormData();
    const corrupted = getCorruptedJpegFixture();
    corruptForm.append(
      'file',
      new Blob([new Uint8Array(corrupted.buffer)], {
        type: corrupted.mimeType,
      }),
      corrupted.name,
    );
    const corruptRes = await request.post(
      `/api/stories/${story.id}/illustrations/2`,
      { multipart: corruptForm },
    );
    expect(corruptRes.status()).toBeLessThan(500);

    // Invalid pageNumber / empty text on PATCH page
    const badPageNumRes = await request.patch(
      `/api/stories/${story.id}/pages/99`,
      { data: { text: 'Tekst poza zakresem' } },
    );
    expect([400, 404]).toContain(badPageNumRes.status());

    const zeroPageRes = await request.patch(
      `/api/stories/${story.id}/pages/0`,
      { data: { text: 'Zerowa strona' } },
    );
    expect([400, 404]).toContain(zeroPageRes.status());

    const emptyTextRes = await request.patch(
      `/api/stories/${story.id}/pages/1`,
      { data: { text: '' } },
    );
    expect([400, 422]).toContain(emptyTextRes.status());

    // Invalid PDF format & missing story PDF
    const badFormatPdfRes = await request.get(
      `/api/stories/${story.id}/pdf?format=poster-a0`,
    );
    expect(badFormatPdfRes.status()).toBe(400);

    const missingPdfRes = await request.get(
      '/api/stories/nonexistent-story-id-9999/pdf?format=square',
    );
    expect(missingPdfRes.status()).toBe(404);

    // Invalid settings enum patch
    const badSettingsRes = await request.patch('/api/settings', {
      data: { activeProvider: 'nonexistent-provider', defaultBookFormat: 'a0' },
    });
    expect([400, 422]).toContain(badSettingsRes.status());

    guard.assertClean();
  });

  test('T2-03: Out-of-bounds slide queries (?slide=-1, ?slide=999, ?slide=abc) clamp gracefully and unknown story 404s cleanly', async ({
    page,
    request,
  }) => {
    const guard = attachErrorGuards(page);
    activeTracker = createStoryTracker(page, request);

    const story = await createStoryViaApi(request, {
      childName: 'Nadia',
      childAge: 5,
      gender: 'girl',
      pageCount: 10,
      provider: 'demo',
    });
    activeTracker.track(story.id);

    // ?slide=-1 clamps cleanly to first slide (Cover)
    await page.goto(`/story/${story.id}?slide=-1`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.getByTestId('story-slide')).toBeVisible();
    await expect(page.getByTestId('story-slide')).toContainText(story.title);

    // ?slide=999 clamps cleanly to final slide (Back Cover)
    await page.goto(`/story/${story.id}?slide=999`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.getByTestId('story-slide')).toBeVisible();
    await expect(page.getByTestId('story-slide')).toContainText(
      story.backCoverBlurb.slice(0, 20),
    );

    // ?slide=abc falls back cleanly without crash
    await page.goto(`/story/${story.id}?slide=abc`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.getByTestId('story-slide')).toBeVisible();

    // Unknown valid story ID renders 404 without uncaught pageerror or 5xx
    guard.allowExpectedHttpError({
      status: 404,
      urlPattern: /\/story\/nonexistent-story-id-9999/,
    });
    const notFoundRes = await page.goto('/story/nonexistent-story-id-9999', {
      waitUntil: 'domcontentloaded',
    });
    expect(notFoundRes?.status()).toBe(404);

    guard.assertClean();
  });

  test('T2-04: Long edited Polish text with full diacritics, quotes, and dashes persists and exports cleanly to PDF', async ({
    page,
    request,
  }) => {
    const guard = attachErrorGuards(page);
    activeTracker = createStoryTracker(page, request);

    const story = await createStoryViaApi(request, {
      childName: 'Małgosia',
      childAge: 7,
      gender: 'girl',
      pageCount: 6,
      provider: 'demo',
    });
    activeTracker.track(story.id);

    const longDiacriticText =
      '„Zażółć gęślą jaźń!” — krzyknęła Małgosia, patrząc na źródło lśniące w śródleśnej polanie. ' +
      'Żółć, ćma, łoś i bąk tańczyły w świetle księżyca – każdy dźwięk był miękki jak puch. ' +
      'W końcu dziewczynka uśmiechnęła się szeroko, zapisała tę niezwykłą przygodę w złotym pamiętniku i ruszyła dalej ku gwiazdom.';

    await page.goto(`/story/${story.id}?slide=2`);
    await page.getByTestId('edit-text-btn').click();
    await page.getByTestId('edit-text-area').fill(longDiacriticText);

    const savePromise = page.waitForResponse(
      (res) =>
        res.request().method() === 'PATCH' &&
        res.url().includes(`/api/stories/${story.id}/pages/1`),
    );
    await page.getByTestId('save-text-btn').click();
    expect((await savePromise).status()).toBe(200);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('story-slide')).toContainText(
      'Zażółć gęślą jaźń!',
    );
    await expect(page.getByTestId('story-slide')).toContainText(
      'złotym pamiętniku',
    );

    // Export binary PDF and verify full Polish diacritics survived PDF font embedding
    await expectBinaryPdfDownload(
      page,
      async () => {
        await page.getByTestId('download-pdf-square').click();
      },
      {
        expectedFormat: 'square',
        expectedPageCount: 9,
        expectedTextSnippets: ['Zażółć gęślą jaźń', 'Małgosia'],
      },
    );

    guard.assertClean();
  });

  test('T2-05: Empty library state renders cleanly when all stories are deleted', async ({
    page,
    request,
  }) => {
    const guard = attachErrorGuards(page);
    activeTracker = createStoryTracker(page, request);

    await cleanupAllStories(request);

    await page.goto('/library');
    await expect(page.getByTestId('library-card')).toHaveCount(0);

    // Empty state renders meaningful Polish guidance and link/action back to Creator
    const bodyText = await page.locator('body').innerText();
    expect(bodyText.trim().length).toBeGreaterThan(20);
    await expect(page.locator('a[href="/"]').first()).toBeVisible();

    guard.assertClean();
  });
});
