import fs from 'node:fs/promises';
import {
  expect,
  type APIRequestContext,
  type ConsoleMessage,
  type Download,
  type Locator,
  type Page,
  type Response,
} from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import {
  getChildPhotoFixture,
  type E2EFilePayload,
} from './fixtures/images';

export type ChildGender = 'girl' | 'boy';
export type ArtStyle =
  | 'watercolor'
  | 'storybook-gouache'
  | 'vintage-etching'
  | 'paper-cutout';
export type StoryMood =
  | 'warm-cozy'
  | 'magical-adventure'
  | 'funny-playful'
  | 'bedtime-calm';
export type BookFormat = 'square' | 'a4-landscape';
export type ProviderId =
  | 'demo'
  | 'manual'
  | 'gemini-api'
  | 'google-subscription';
export type GenerationMode = 'full' | 'preview-first';
export type GenerationStage = 'complete' | 'preview' | 'awaiting-manual-art';
export type ImageStatus =
  | 'ready'
  | 'pending'
  | 'awaiting-upload'
  | 'custom-uploaded'
  | 'error';

export interface StoryInputDto {
  childName: string;
  childAge: number;
  gender: ChildGender;
  companion?: string;
  theme: string;
  artStyle: ArtStyle;
  mood: StoryMood;
  pageCount: number;
  dedicationFrom?: string;
}

export interface StoryPageDto {
  pageNumber: number;
  chapterTitle: string;
  text: string;
  imagePrompt: string;
  imageFilename: string | null;
  demoAssetPath?: string | null;
  imageStatus: ImageStatus;
  imageUpdatedAt?: string;
}

export interface StoryRecordDto {
  id: string;
  createdAt: string;
  updatedAt: string;
  provider: ProviderId;
  generationMode: GenerationMode;
  generationStage: GenerationStage;
  bookFormat: BookFormat;
  input: StoryInputDto;
  title: string;
  subtitle: string;
  dedicationText: string;
  backCoverBlurb: string;
  characterBible: string;
  coverPrompt: string;
  coverFilename: string | null;
  demoCoverPath?: string | null;
  coverStatus: ImageStatus;
  coverUpdatedAt?: string;
  referencePhotos: string[];
  pages: StoryPageDto[];
  modelsUsed: {
    textModel: string;
    imageModel: string;
  };
}

export interface StorySummaryDto {
  id: string;
  title: string;
  subtitle: string;
  childName: string;
  childAge: number;
  gender: ChildGender;
  provider: ProviderId;
  generationStage: GenerationStage;
  bookFormat: BookFormat;
  pageCount: number;
  coverUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeSettingsDto {
  activeProvider: ProviderId;
  textModel: string;
  imageModel: string;
  defaultPreviewFirst: boolean;
  defaultBookFormat: BookFormat;
}

export const ALL_ART_STYLES: readonly ArtStyle[] = [
  'watercolor',
  'storybook-gouache',
  'vintage-etching',
  'paper-cutout',
] as const;

export const ALL_STORY_MOODS: readonly StoryMood[] = [
  'warm-cozy',
  'magical-adventure',
  'funny-playful',
  'bedtime-calm',
] as const;

export const MOBILE_VIEWPORT = { width: 390, height: 844 } as const;
export const DESKTOP_VIEWPORT = { width: 1280, height: 800 } as const;

export interface ExpectedHttpErrorRule {
  status: number;
  urlPattern: RegExp;
}

export interface ErrorGuard {
  allowExpectedHttpError(rule: ExpectedHttpErrorRule): void;
  assertClean(): void;
  readonly pageErrors: readonly string[];
  readonly consoleErrors: readonly string[];
  readonly server5xxErrors: readonly string[];
}

const CHROMIUM_HTTP_ERROR_PATTERN =
  /^Failed to load resource: the server responded with a status of (4\d\d)\b/;

export function attachErrorGuards(page: Page): ErrorGuard {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const server5xxErrors: string[] = [];
  const allowedRules: ExpectedHttpErrorRule[] = [];

  page.on('pageerror', (error: Error) => {
    pageErrors.push(`${error.name}: ${error.message}`);
  });

  page.on('response', (response: Response) => {
    if (response.status() >= 500) {
      server5xxErrors.push(
        `${response.request().method()} ${response.status()} ${response.url()}`,
      );
    }
  });

  page.on('console', (message: ConsoleMessage) => {
    if (message.type() !== 'error') {
      return;
    }

    const text = message.text();
    const location = message.location();
    const match = CHROMIUM_HTTP_ERROR_PATTERN.exec(text);

    if (match && location.lineNumber === 0 && location.columnNumber === 0) {
      const status = Number(match[1]);
      const isAllowed = allowedRules.some(
        (rule) => rule.status === status && rule.urlPattern.test(location.url),
      );
      if (isAllowed) {
        return;
      }
    }

    const locSuffix = location.url
      ? ` (${location.url}:${location.lineNumber}:${location.columnNumber})`
      : '';
    consoleErrors.push(`${text}${locSuffix}`);
  });

  return {
    allowExpectedHttpError(rule: ExpectedHttpErrorRule): void {
      if (rule.status < 400 || rule.status > 499) {
        throw new Error(
          `ExpectedHttpErrorRule status must be 400..499, received ${rule.status}`,
        );
      }
      allowedRules.push(rule);
    },
    assertClean(): void {
      const diagnostics: string[] = [];
      if (pageErrors.length > 0) {
        diagnostics.push(`Uncaught pageerror(s):\n  - ${pageErrors.join('\n  - ')}`);
      }
      if (consoleErrors.length > 0) {
        diagnostics.push(
          `Browser console.error(s):\n  - ${consoleErrors.join('\n  - ')}`,
        );
      }
      if (server5xxErrors.length > 0) {
        diagnostics.push(
          `HTTP 5xx server response(s):\n  - ${server5xxErrors.join('\n  - ')}`,
        );
      }
      expect(
        diagnostics,
        `Expected zero browser/server errors, found:\n${diagnostics.join('\n')}`,
      ).toEqual([]);
    },
    pageErrors,
    consoleErrors,
    server5xxErrors,
  };
}

export interface StoryTracker {
  track(storyId: string): void;
  getTrackedIds(): string[];
  cleanup(): Promise<void>;
}

function extractStoryIdFromJson(body: unknown): string | null {
  if (!body || typeof body !== 'object') {
    return null;
  }
  const record = body as Record<string, unknown>;
  const story = record.story;
  if (!story || typeof story !== 'object') {
    return null;
  }
  const id = (story as Record<string, unknown>).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export function createStoryTracker(
  page: Page,
  request: APIRequestContext,
): StoryTracker {
  const trackedIds = new Set<string>();

  page.on('response', (response: Response) => {
    if (
      response.request().method() === 'POST' &&
      /\/api\/stories\/?$/.test(new URL(response.url()).pathname) &&
      response.status() === 201
    ) {
      void response
        .json()
        .then((body: unknown) => {
          const id = extractStoryIdFromJson(body);
          if (id) {
            trackedIds.add(id);
          }
        })
        .catch(() => {
          // Ignore response body parse errors if page closed early.
        });
    }
  });

  return {
    track(storyId: string): void {
      if (storyId.length > 0) {
        trackedIds.add(storyId);
      }
    },
    getTrackedIds(): string[] {
      return Array.from(trackedIds);
    },
    async cleanup(): Promise<void> {
      const ids = Array.from(trackedIds);
      trackedIds.clear();
      for (const id of ids) {
        const res = await request.delete(`/api/stories/${encodeURIComponent(id)}`);
        expect([200, 404]).toContain(res.status());
      }
    },
  };
}

export async function cleanupAllStories(
  request: APIRequestContext,
): Promise<void> {
  const listRes = await request.get('/api/stories');
  expect(listRes.status()).toBe(200);
  const data = (await listRes.json()) as { stories?: StorySummaryDto[] };
  const stories = Array.isArray(data.stories) ? data.stories : [];
  for (const story of stories) {
    const delRes = await request.delete(
      `/api/stories/${encodeURIComponent(story.id)}`,
    );
    expect([200, 404]).toContain(delRes.status());
  }
}

export async function restoreDefaultSettings(
  request: APIRequestContext,
): Promise<void> {
  const res = await request.patch('/api/settings', {
    data: {
      activeProvider: 'demo',
      defaultPreviewFirst: false,
      defaultBookFormat: 'square',
    },
  });
  expect(res.status()).toBe(200);
}

export async function fetchStoryViaApi(
  request: APIRequestContext,
  storyId: string,
): Promise<StoryRecordDto> {
  const res = await request.get(`/api/stories/${encodeURIComponent(storyId)}`);
  expect(res.status()).toBe(200);
  const json = (await res.json()) as { story: StoryRecordDto };
  expect(json.story.id).toBe(storyId);
  return json.story;
}

export interface CreateStoryApiOptions {
  childName?: string;
  childAge?: number;
  gender?: ChildGender;
  companion?: string;
  theme?: string;
  artStyle?: ArtStyle;
  mood?: StoryMood;
  pageCount?: number;
  provider?: ProviderId;
  bookFormat?: BookFormat;
  generationMode?: GenerationMode;
  photos?: E2EFilePayload[];
}

export async function createStoryViaApi(
  request: APIRequestContext,
  options: CreateStoryApiOptions = {},
): Promise<StoryRecordDto> {
  const photos =
    options.photos && options.photos.length > 0
      ? options.photos
      : [await getChildPhotoFixture(1)];

  const payload = {
    childName: options.childName ?? 'Zosia',
    childAge: options.childAge ?? 5,
    gender: options.gender ?? 'girl',
    companion: options.companion ?? 'rudy kotek Mruczek',
    theme: options.theme ?? 'Wyprawa do zaczarowanego lasu świetlików',
    artStyle: options.artStyle ?? 'watercolor',
    mood: options.mood ?? 'warm-cozy',
    pageCount: options.pageCount ?? 10,
    provider: options.provider ?? 'demo',
    bookFormat: options.bookFormat ?? 'square',
    generationMode: options.generationMode ?? 'full',
  };

  const form = new FormData();
  form.append('payload', JSON.stringify(payload));
  for (const photo of photos) {
    const blobBytes = new Uint8Array(photo.buffer);
    form.append(
      'photos',
      new Blob([blobBytes], { type: photo.mimeType }),
      photo.name,
    );
  }

  const res = await request.post('/api/stories', {
    multipart: form,
  });
  expect(res.status(), `POST /api/stories failed: ${await res.text()}`).toBe(
    201,
  );
  const json = (await res.json()) as { story: StoryRecordDto };
  return json.story;
}

export async function selectGender(
  page: Page,
  gender: ChildGender,
): Promise<void> {
  const target = page.getByTestId(`gender-${gender}`);
  await expect(target).toBeVisible();
  const meta = await target.evaluate((el) => ({
    tag: el.tagName.toUpperCase(),
    type: el.getAttribute('type')?.toLowerCase() ?? '',
  }));

  if (meta.tag === 'INPUT' && meta.type === 'radio') {
    await target.check({ force: true });
  } else {
    await target.click();
  }
}

export async function selectProvider(
  page: Page,
  testId: 'provider-select' | 'settings-provider-select',
  providerId: ProviderId,
): Promise<void> {
  const locator = page.getByTestId(testId);
  await expect(locator).toBeVisible();
  const tagName = await locator.evaluate((el) => el.tagName.toUpperCase());

  if (tagName === 'SELECT') {
    await locator.selectOption(providerId);
    return;
  }

  const radioOption = locator.locator(`input[value="${providerId}"]`).first();
  if ((await radioOption.count()) > 0) {
    await radioOption.check({ force: true });
    return;
  }

  const attrOption = locator
    .locator(
      `[data-value="${providerId}"], [data-provider="${providerId}"], [data-testid*="${providerId}"]`,
    )
    .first();
  if ((await attrOption.count()) > 0) {
    await attrOption.click();
    return;
  }

  const labelHints: Record<ProviderId, RegExp> = {
    demo: /demo/i,
    manual: /ręczny|reczny|manual|nano banana/i,
    'gemini-api': /gemini/i,
    'google-subscription': /subskrypc|subscription/i,
  };
  await locator
    .locator('button, label, [role="radio"], [role="option"]')
    .filter({ hasText: labelHints[providerId] })
    .first()
    .click();
}

export async function readSelectedProvider(
  page: Page,
  testId: 'provider-select' | 'settings-provider-select',
): Promise<string> {
  const locator = page.getByTestId(testId);
  await expect(locator).toBeVisible();
  const tagName = await locator.evaluate((el) => el.tagName.toUpperCase());

  if (tagName === 'SELECT') {
    return locator.inputValue();
  }

  return locator.evaluate((root) => {
    const checkedRadio = root.querySelector<HTMLInputElement>(
      'input[type="radio"]:checked',
    );
    if (checkedRadio) {
      return checkedRadio.value;
    }
    const pressed = root.querySelector<HTMLElement>(
      '[aria-pressed="true"], [aria-checked="true"], [data-selected="true"]',
    );
    if (pressed) {
      return (
        pressed.getAttribute('data-provider') ??
        pressed.getAttribute('data-value') ??
        pressed.textContent?.trim() ??
        ''
      );
    }
    return '';
  });
}

export async function setPreviewFirst(
  page: Page,
  enabled: boolean,
): Promise<void> {
  const locator = page.getByTestId('preview-first-toggle');
  await expect(locator).toBeVisible();

  const meta = await locator.evaluate((el) => ({
    tag: el.tagName.toUpperCase(),
    type: el.getAttribute('type')?.toLowerCase() ?? '',
    ariaChecked: el.getAttribute('aria-checked'),
    ariaPressed: el.getAttribute('aria-pressed'),
    dataChecked: el.getAttribute('data-checked'),
  }));

  if (meta.tag === 'INPUT' && meta.type === 'checkbox') {
    await locator.setChecked(enabled);
    return;
  }

  const nestedCheckbox = locator.locator('input[type="checkbox"]').first();
  if ((await nestedCheckbox.count()) > 0) {
    await nestedCheckbox.setChecked(enabled);
    return;
  }

  const currentState =
    meta.ariaChecked === 'true' ||
    meta.ariaPressed === 'true' ||
    meta.dataChecked === 'true';
  if (currentState !== enabled) {
    await locator.click();
  }
}

export async function setNumericField(
  locator: Locator,
  value: number,
): Promise<void> {
  await expect(locator).toBeVisible();
  const tagName = await locator.evaluate((el) => el.tagName.toUpperCase());
  if (tagName === 'SELECT') {
    await locator.selectOption(String(value));
  } else {
    await locator.fill(String(value));
  }
}

export async function uploadFilesToTestId(
  page: Page,
  testId: string,
  files: E2EFilePayload | E2EFilePayload[],
): Promise<void> {
  const locator = page.getByTestId(testId);
  await expect(locator).toBeAttached();

  const isFileInput = await locator.evaluate(
    (el) =>
      el.tagName.toUpperCase() === 'INPUT' &&
      el.getAttribute('type')?.toLowerCase() === 'file',
  );

  if (isFileInput) {
    await locator.setInputFiles(files);
  } else {
    const nestedInput = locator.locator('input[type="file"]').first();
    await expect(nestedInput).toBeAttached();
    await nestedInput.setInputFiles(files);
  }
}

export interface CreatorFormOptions {
  photos?: E2EFilePayload[];
  childName: string;
  childAge: number;
  gender: ChildGender;
  companion?: string;
  theme?: string;
  inspirationIndex?: number;
  artStyle?: ArtStyle;
  mood?: StoryMood;
  pageCount?: number;
  provider?: ProviderId;
  previewFirst?: boolean;
}

export async function fillCreatorFormAndSubmit(
  page: Page,
  options: CreatorFormOptions,
): Promise<{ storyId: string; url: string }> {
  const photos =
    options.photos && options.photos.length > 0
      ? options.photos
      : [await getChildPhotoFixture(1)];

  await uploadFilesToTestId(page, 'photo-input', photos);
  await page.getByTestId('child-name-input').fill(options.childName);
  await setNumericField(page.getByTestId('child-age-input'), options.childAge);
  await selectGender(page, options.gender);

  if (options.companion !== undefined) {
    await page.getByTestId('companion-input').fill(options.companion);
  }

  if (options.inspirationIndex !== undefined) {
    await page
      .getByTestId('inspiration-chip')
      .nth(options.inspirationIndex)
      .click();
  }
  if (options.theme !== undefined) {
    await page.getByTestId('theme-input').fill(options.theme);
  }

  if (options.artStyle) {
    await page.getByTestId(`style-card-${options.artStyle}`).click();
  }
  if (options.mood) {
    await page.getByTestId(`mood-pill-${options.mood}`).click();
  }
  if (options.pageCount !== undefined) {
    await setNumericField(
      page.getByTestId('page-count-input'),
      options.pageCount,
    );
  }
  if (options.provider) {
    await selectProvider(page, 'provider-select', options.provider);
  }
  if (options.previewFirst !== undefined) {
    await setPreviewFirst(page, options.previewFirst);
  }

  const createResponsePromise = page.waitForResponse(
    (res) =>
      res.request().method() === 'POST' &&
      /\/api\/stories\/?$/.test(new URL(res.url()).pathname),
    { timeout: 60_000 },
  );

  await page.getByTestId('create-story-submit').click();

  const createResponse = await createResponsePromise;
  expect(
    createResponse.status(),
    `Creator submission returned ${createResponse.status()}: ${await createResponse.text()}`,
  ).toBe(201);

  const body = (await createResponse.json()) as { story: StoryRecordDto };
  const storyId = body.story.id;
  expect(storyId).toMatch(/^[a-z0-9][a-z0-9_-]{3,63}$/);

  await expect(page).toHaveURL(new RegExp(`/story/${storyId}(?:\\?|$)`), {
    timeout: 30_000,
  });
  await expect(page.getByTestId('story-slide')).toBeVisible();

  return { storyId, url: page.url() };
}

export async function expectLoadedImage(
  locator: Locator,
  timeoutMs = 15_000,
): Promise<{ naturalWidth: number; naturalHeight: number; src: string }> {
  await expect(locator).toBeVisible({ timeout: timeoutMs });

  await expect
    .poll(
      async () =>
        locator.evaluate((el) => {
          const img =
            el.tagName.toUpperCase() === 'IMG'
              ? (el as HTMLImageElement)
              : el.querySelector('img');
          if (!img) {
            return { loaded: false, width: 0, height: 0, src: '' };
          }
          return {
            loaded: img.complete && img.naturalWidth > 0,
            width: img.naturalWidth,
            height: img.naturalHeight,
            src: img.currentSrc || img.src,
          };
        }),
      { timeout: timeoutMs },
    )
    .toMatchObject({ loaded: true });

  return locator.evaluate((el) => {
    const img =
      el.tagName.toUpperCase() === 'IMG'
        ? (el as HTMLImageElement)
        : el.querySelector('img');
    if (!img) {
      throw new Error('Expected an <img> element inside locator');
    }
    return {
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      src: img.currentSrc || img.src,
    };
  });
}

export async function expectAllVisibleImagesLoaded(page: Page): Promise<number> {
  const brokenImages = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img'));
    const broken: string[] = [];
    for (const img of imgs) {
      const style = window.getComputedStyle(img);
      const rect = img.getBoundingClientRect();
      const visible =
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0;
      if (visible && (!img.complete || img.naturalWidth === 0)) {
        broken.push(img.currentSrc || img.src || '(empty src)');
      }
    }
    return broken;
  });
  expect(brokenImages, 'Expected zero broken visible images').toEqual([]);

  return page.evaluate(() => document.querySelectorAll('img').length);
}

export async function deleteStoryFromLibrary(
  page: Page,
  storyMarker: string,
): Promise<void> {
  const card = page
    .getByTestId('library-card')
    .filter({ hasText: storyMarker })
    .first();
  await expect(card).toBeVisible();

  await card.getByTestId('library-delete-btn').click();

  const confirmBtn = card
    .getByTestId('library-delete-confirm')
    .or(page.getByTestId('library-delete-confirm'))
    .first();
  await expect(confirmBtn).toBeVisible();

  const deleteResponsePromise = page.waitForResponse(
    (res) =>
      res.request().method() === 'DELETE' &&
      /\/api\/stories\/[^/]+$/.test(new URL(res.url()).pathname),
    { timeout: 15_000 },
  );

  await confirmBtn.click();

  const deleteResponse = await deleteResponsePromise;
  expect(deleteResponse.status()).toBe(200);
  await expect(card).toHaveCount(0);
}

export function expectPdfApiHeaders(headers: Record<string, string>): void {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = value;
  }

  expect(normalized['content-type'] ?? '').toContain('application/pdf');
  expect(normalized['content-disposition'] ?? '').toMatch(
    /^attachment;\s*filename="[^"]+\.pdf"/i,
  );
  expect((normalized['x-content-type-options'] ?? '').toLowerCase()).toBe(
    'nosniff',
  );
  expect((normalized['cache-control'] ?? '').toLowerCase()).toContain(
    'no-store',
  );
}

async function readDownloadBytes(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  if (stream) {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    if (chunks.length > 0) {
      return Buffer.concat(chunks);
    }
  }
  const filePath = await download.path();
  if (!filePath) {
    throw new Error('Playwright download did not provide a readable path');
  }
  return fs.readFile(filePath);
}

export interface PdfDownloadCheckOptions {
  minBytes?: number;
  expectedFormat?: BookFormat;
  expectedPageCount?: number;
  expectedFilenamePattern?: RegExp;
  expectedTextSnippets?: string[];
  timeoutMs?: number;
}

export interface VerifiedPdfResult {
  filename: string;
  bytes: Buffer;
  pageCount: number;
  pageSize: { width: number; height: number };
  extractedText?: string;
}

export async function expectBinaryPdfDownload(
  page: Page,
  triggerDownload: () => Promise<void>,
  options: PdfDownloadCheckOptions = {},
): Promise<VerifiedPdfResult> {
  const urlBefore = page.url();
  const capturedPdfResponses: Response[] = [];

  const onResponse = (res: Response): void => {
    if (
      res.request().method() === 'GET' &&
      /\/api\/stories\/[^/]+\/pdf(?:\?|$)/.test(res.url())
    ) {
      capturedPdfResponses.push(res);
    }
  };
  page.on('response', onResponse);

  let download: Download;
  try {
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: options.timeoutMs ?? 30_000 }),
      triggerDownload(),
    ]);
    download = dl;
  } finally {
    page.off('response', onResponse);
  }

  expect(await download.failure()).toBeNull();

  if (capturedPdfResponses.length > 0) {
    const pdfRes = capturedPdfResponses[capturedPdfResponses.length - 1];
    expect(pdfRes.status()).toBe(200);
    expectPdfApiHeaders(pdfRes.headers());
  }

  const filename = download.suggestedFilename();
  expect(filename).toMatch(options.expectedFilenamePattern ?? /\.pdf$/i);

  const bytes = await readDownloadBytes(download);
  const minBytes = options.minBytes ?? 20_480;
  expect(
    bytes.length,
    `Expected binary PDF > ${minBytes} bytes, got ${bytes.length} bytes`,
  ).toBeGreaterThan(minBytes);
  expect(bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');

  const trailerSlice = bytes
    .subarray(Math.max(0, bytes.length - 1024))
    .toString('ascii');
  expect(trailerSlice).toContain('%%EOF');

  const pdfDoc = await PDFDocument.load(bytes);
  const pageCount = pdfDoc.getPageCount();
  if (options.expectedPageCount !== undefined) {
    expect(pageCount).toBe(options.expectedPageCount);
  }

  const pageSize = pdfDoc.getPage(0).getSize();
  if (options.expectedFormat === 'square') {
    expect(Math.abs(pageSize.width - 595.28)).toBeLessThan(2);
    expect(Math.abs(pageSize.height - 595.28)).toBeLessThan(2);
  } else if (options.expectedFormat === 'a4-landscape') {
    expect(Math.abs(pageSize.width - 841.89)).toBeLessThan(2);
    expect(Math.abs(pageSize.height - 595.28)).toBeLessThan(2);
  }

  let extractedText: string | undefined;
  if (options.expectedTextSnippets && options.expectedTextSnippets.length > 0) {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const proxy = await getDocumentProxy(new Uint8Array(bytes));
    const result = await extractText(proxy, { mergePages: true });
    const rawText = Array.isArray(result.text)
      ? result.text.join(' ')
      : result.text;
    extractedText = rawText.replace(/\s+/g, ' ');
    for (const snippet of options.expectedTextSnippets) {
      expect(
        extractedText,
        `Expected PDF text to contain "${snippet}"`,
      ).toContain(snippet);
    }
  }

  expect(page.url()).toBe(urlBefore);
  const bodyText = await page.locator('body').innerText();
  expect(bodyText).not.toContain('%PDF-');
  expect(bodyText).not.toContain('%PDF-1.7');

  return {
    filename,
    bytes,
    pageCount,
    pageSize,
    extractedText,
  };
}

export async function installClipboardSpy(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const win = window as Window & { __e2eClipboardText?: string };
    win.__e2eClipboardText = '';

    const originalClipboard = navigator.clipboard;
    if (originalClipboard && typeof originalClipboard.writeText === 'function') {
      const originalWriteText = originalClipboard.writeText.bind(originalClipboard);
      try {
        Object.defineProperty(originalClipboard, 'writeText', {
          configurable: true,
          value: async (text: string): Promise<void> => {
            win.__e2eClipboardText = text;
            return originalWriteText(text);
          },
        });
      } catch {
        // Native clipboard writeText is non-configurable in some contexts.
      }
    }

    const originalExecCommand = document.execCommand.bind(document);
    document.execCommand = (
      commandId: string,
      showUI?: boolean,
      value?: string,
    ): boolean => {
      if (commandId.toLowerCase() === 'copy') {
        const selection = window.getSelection()?.toString() ?? '';
        const active = document.activeElement;
        if (selection) {
          win.__e2eClipboardText = selection;
        } else if (
          active instanceof HTMLTextAreaElement ||
          active instanceof HTMLInputElement
        ) {
          win.__e2eClipboardText = active.value;
        }
      }
      return originalExecCommand(commandId, showUI, value);
    };
  });
}

export async function readCopiedPromptAfterClick(page: Page): Promise<string> {
  const origin = new URL(page.url()).origin;
  await page
    .context()
    .grantPermissions(['clipboard-read', 'clipboard-write'], { origin });

  await page.evaluate(async () => {
    const win = window as Window & { __e2eClipboardText?: string };
    win.__e2eClipboardText = '';
    try {
      await navigator.clipboard.writeText('');
    } catch {
      // Ignore if clipboard clear is blocked.
    }
  });

  const copyBtn = page.getByTestId('copy-prompt-btn').first();
  await expect(copyBtn).toBeVisible();
  await copyBtn.click();

  let copiedText = '';
  await expect
    .poll(
      async () => {
        copiedText = await page.evaluate(async () => {
          const win = window as Window & { __e2eClipboardText?: string };
          try {
            const nativeText = await navigator.clipboard.readText();
            if (nativeText && nativeText.trim().length > 0) {
              return nativeText;
            }
          } catch {
            // Fall back to spy capture below.
          }
          return win.__e2eClipboardText ?? '';
        });
        return copiedText.trim().length;
      },
      { timeout: 5_000 },
    )
    .toBeGreaterThan(20);

  expect(copiedText).not.toMatch(/undefined|NaN|\[object Object\]/);
  return copiedText;
}

export interface SsrStoryExpectations {
  expectedTestId: 'story-slide' | 'all-pages-grid';
  expectedTextSnippets: string[];
  expectedUrlPattern: RegExp;
}

export async function expectSsrStoryRoute(
  request: APIRequestContext,
  page: Page,
  storyId: string,
  query: string,
  expectations: SsrStoryExpectations,
): Promise<void> {
  const routePath = `/story/${encodeURIComponent(storyId)}${query}`;

  const rawRes = await request.get(routePath);
  expect(rawRes.status()).toBe(200);
  expect(rawRes.headers()['content-type'] ?? '').toContain('text/html');

  const html = await rawRes.text();
  expect(html).not.toContain('NEXT_NOT_FOUND');
  expect(html).not.toContain('__next_error__');
  expect(html).toContain(`data-testid="${expectations.expectedTestId}"`);
  for (const snippet of expectations.expectedTextSnippets) {
    expect(
      html,
      `Expected SSR HTML for ${routePath} to directly contain "${snippet}" without Suspense bailout`,
    ).toContain(snippet);
  }

  await page.goto(routePath, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(expectations.expectedUrlPattern);
  await expect(page.getByTestId(expectations.expectedTestId)).toBeVisible();

  const bodyText = await page.locator('body').innerText();
  for (const snippet of expectations.expectedTextSnippets) {
    expect(bodyText).toContain(snippet);
  }
}

export async function assertNoHorizontalOverflow(
  page: Page,
  tolerancePx = 1,
): Promise<void> {
  await page.evaluate(async () => {
    if ('fonts' in document) {
      await document.fonts.ready;
    }
  });

  const metrics = await page.evaluate((tol: number) => {
    const innerWidth = window.innerWidth;
    const docScrollWidth = document.documentElement.scrollWidth;
    const bodyScrollWidth = document.body.scrollWidth;
    const offenders: string[] = [];

    if (docScrollWidth > innerWidth + tol || bodyScrollWidth > innerWidth + tol) {
      const elements = Array.from(document.querySelectorAll('*'));
      for (const el of elements) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.right > innerWidth + tol) {
          const testId = el.getAttribute('data-testid');
          const id = el.id ? `#${el.id}` : '';
          const cls =
            typeof el.className === 'string' && el.className.trim()
              ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
              : '';
          offenders.push(
            `${el.tagName.toLowerCase()}${id}${cls}${testId ? `[data-testid="${testId}"]` : ''} right=${Math.round(rect.right)}px`,
          );
          if (offenders.length >= 5) {
            break;
          }
        }
      }
    }

    return { innerWidth, docScrollWidth, bodyScrollWidth, offenders };
  }, tolerancePx);

  const diagnostic = `Horizontal overflow detected at viewport ${metrics.innerWidth}px (doc=${metrics.docScrollWidth}px, body=${metrics.bodyScrollWidth}px). Offenders: ${metrics.offenders.join(', ') || 'none'}`;
  expect(metrics.docScrollWidth, diagnostic).toBeLessThanOrEqual(
    metrics.innerWidth + tolerancePx,
  );
  expect(metrics.bodyScrollWidth, diagnostic).toBeLessThanOrEqual(
    metrics.innerWidth + tolerancePx,
  );
}
