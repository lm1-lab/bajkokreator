import fs from 'node:fs/promises';
import {
  expect,
  type APIRequestContext,
  type APIResponse,
  type Download,
  type Page,
  type Response,
} from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import {
  getChildPhotoFixture,
  type E2EFilePayload,
} from './fixtures/images';
import {
  createStoryTracker,
  expectPdfApiHeaders,
  fetchStoryViaApi,
  restoreDefaultSettings,
  type BookFormat,
  type CreateStoryApiOptions,
  type StoryRecordDto,
  type StorySummaryDto,
} from './helpers';

export const PT_PER_MM = 72 / 25.4;

export function mmToPt(mm: number): number {
  return mm * PT_PER_MM;
}

export const TRIM_DIMENSIONS_PT: Readonly<
  Record<BookFormat, { width: number; height: number }>
> = {
  square: { width: 595.28, height: 595.28 },
  'a4-landscape': { width: 841.89, height: 595.28 },
};

export const ORDER_NUMBER_RE = /^BK-\d{4}-[A-Z0-9]{6}$/;
export const UUID_OR_SAFE_REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function assertPngMagic(buffer: Buffer, label: string): void {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new Error(`Generated ${label} does not start with valid PNG magic bytes`);
  }
}

function assertWebpMagic(buffer: Buffer, label: string): void {
  if (
    buffer.length < 12 ||
    buffer.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    buffer.subarray(8, 12).toString('ascii') !== 'WEBP'
  ) {
    throw new Error(`Generated ${label} does not have valid RIFF/WEBP magic bytes`);
  }
}

function buildPrintSceneSvg(
  width: number,
  height: number,
  variant: 'cover' | 'page' | 'webp' | 'tiny',
): string {
  const palettes = {
    cover: { top: '#1d3557', bottom: '#e9c46a', accent: '#f4a261', hill: '#2a9d8f' },
    page: { top: '#264653', bottom: '#f4d35e', accent: '#ee964b', hill: '#457b9d' },
    webp: { top: '#3d405b', bottom: '#f2cc8f', accent: '#e07a5f', hill: '#81b29a' },
    tiny: { top: '#6d597a', bottom: '#eaac8b', accent: '#e56b6f', hill: '#355070' },
  } as const;
  const p = palettes[variant];
  const sunR = Math.round(Math.min(width, height) * 0.12);
  const sunX = Math.round(width * 0.72);
  const sunY = Math.round(height * 0.28);

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${p.top}" />
          <stop offset="100%" stop-color="${p.bottom}" />
        </linearGradient>
      </defs>
      <rect width="${width}" height="${height}" fill="url(#sky)" />
      <circle cx="${sunX}" cy="${sunY}" r="${sunR}" fill="${p.accent}" />
      <path d="M0 ${Math.round(height * 0.72)} Q ${Math.round(width * 0.25)} ${Math.round(height * 0.52)} ${Math.round(width * 0.55)} ${Math.round(height * 0.68)} T ${width} ${Math.round(height * 0.64)} L ${width} ${height} L 0 ${height} Z" fill="${p.hill}" />
      <circle cx="${Math.round(width * 0.28)}" cy="${Math.round(height * 0.62)}" r="${Math.max(6, Math.round(sunR * 0.55))}" fill="#ffffff" fill-opacity="0.85" />
    </svg>
  `.trim();
}

const printReadyPngCache = new Map<'cover' | 'page', Promise<Buffer>>();
let printReadyWebpCache: Promise<Buffer> | null = null;
let tinyBlockingPngCache: Promise<Buffer> | null = null;

/**
 * 1800×1200 sRGB PNG (~256 DPI on square page, ~291 DPI on square cover).
 * Deterministically passes print preflight with zero DPI errors/warnings.
 */
export async function getPrintReadyIllustrationPng(
  variant: 'cover' | 'page' = 'page',
): Promise<E2EFilePayload> {
  let pending = printReadyPngCache.get(variant);
  if (!pending) {
    pending = (async () => {
      const svg = buildPrintSceneSvg(1800, 1200, variant);
      const buffer = await sharp(Buffer.from(svg))
        .toColorspace('srgb')
        .png({ compressionLevel: 6 })
        .toBuffer();
      assertPngMagic(buffer, `print-ready-${variant}.png`);
      return buffer;
    })();
    printReadyPngCache.set(variant, pending);
  }
  const buffer = await pending;
  return {
    name: `print-ready-${variant}.png`,
    mimeType: 'image/png',
    buffer,
  };
}

/**
 * 1800×1200 sRGB WebP (~256 DPI on square page).
 * Exercises Sharp WebP-to-JPEG PDF transcoding while passing print preflight.
 */
export async function getPrintReadyIllustrationWebp(): Promise<E2EFilePayload> {
  if (!printReadyWebpCache) {
    printReadyWebpCache = (async () => {
      const svg = buildPrintSceneSvg(1800, 1200, 'webp');
      const buffer = await sharp(Buffer.from(svg))
        .toColorspace('srgb')
        .webp({ quality: 88 })
        .toBuffer();
      assertWebpMagic(buffer, 'print-ready-page.webp');
      return buffer;
    })();
  }
  const buffer = await printReadyWebpCache;
  return {
    name: 'print-ready-page.webp',
    mimeType: 'image/webp',
    buffer,
  };
}

/**
 * 100×100 sRGB PNG (< 20 DPI on square/A4 cover or page slot).
 * Deterministically triggers LOW_IMAGE_RESOLUTION_BLOCKING in preflight.
 */
export async function getTinyBlockingIllustrationPng(): Promise<E2EFilePayload> {
  if (!tinyBlockingPngCache) {
    tinyBlockingPngCache = (async () => {
      const svg = buildPrintSceneSvg(100, 100, 'tiny');
      const buffer = await sharp(Buffer.from(svg))
        .toColorspace('srgb')
        .png({ compressionLevel: 6 })
        .toBuffer();
      assertPngMagic(buffer, 'tiny-blocking-art.png');
      return buffer;
    })();
  }
  const buffer = await tinyBlockingPngCache;
  return {
    name: 'tiny-blocking-art.png',
    mimeType: 'image/png',
    buffer,
  };
}

export function getOpsAuthHeaders(
  extra?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = process.env.BAJKOKREATOR_OPS_TOKEN?.trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      headers[key] = value;
    }
  }
  return headers;
}

export function uniqueIdempotencyKey(prefix: string): string {
  const randomSuffix = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now()}-${randomSuffix}`;
}

export interface ApiErrorEnvelope {
  error: string;
  code: string;
  requestId: string;
  issues?: unknown;
  quota?: unknown;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export function expectRequestIdHeader(
  res: APIResponse,
  expectedRequestId?: string,
): string {
  const headerVal = res.headers()['x-request-id'];
  expect(
    headerVal,
    `Expected non-empty X-Request-Id header on ${res.url()} (${res.status()})`,
  ).toBeTruthy();
  expect(headerVal).toMatch(UUID_OR_SAFE_REQUEST_ID_RE);
  if (expectedRequestId !== undefined) {
    expect(headerVal).toBe(expectedRequestId);
  }
  return headerVal;
}

export async function expectApiErrorEnvelope(
  res: APIResponse,
  opts: {
    status: number | readonly number[];
    code?: string | RegExp;
    expectedRequestId?: string;
    requireRetryAfter?: boolean;
  },
): Promise<ApiErrorEnvelope> {
  const allowedStatuses = Array.isArray(opts.status)
    ? opts.status
    : [opts.status];
  const rawText = await res.text();
  expect(
    allowedStatuses,
    `Unexpected status ${res.status()} on ${res.url()}: ${rawText}`,
  ).toContain(res.status());

  const headerRequestId = expectRequestIdHeader(res, opts.expectedRequestId);
  const cacheControl = (res.headers()['cache-control'] ?? '').toLowerCase();
  expect(
    cacheControl,
    `Expected Cache-Control: no-store on error response ${res.url()}`,
  ).toContain('no-store');

  if (opts.requireRetryAfter) {
    const retryAfter = Number(res.headers()['retry-after']);
    expect(Number.isFinite(retryAfter) && retryAfter >= 1).toBe(true);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error(`Expected JSON error envelope from ${res.url()}, got: ${rawText}`);
  }
  expect(parsed && typeof parsed === 'object').toBe(true);
  const body = parsed as Partial<ApiErrorEnvelope>;

  expect(typeof body.error).toBe('string');
  expect((body.error ?? '').trim().length).toBeGreaterThan(0);
  expect(typeof body.code).toBe('string');
  expect((body.code ?? '').trim().length).toBeGreaterThan(0);
  expect(body.requestId).toBe(headerRequestId);

  if (opts.code !== undefined) {
    if (typeof opts.code === 'string') {
      expect(body.code).toBe(opts.code);
    } else {
      expect(body.code).toMatch(opts.code);
    }
  }

  return body as ApiErrorEnvelope;
}

export type PdfLayoutMode = 'combined' | 'interior' | 'cover-wrap';

export interface PdfBoxRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PrintPdfExpectations {
  format: BookFormat;
  layoutMode?: PdfLayoutMode;
  bleedMm?: number;
  cropMarks?: boolean;
  padToMultipleOf4?: boolean;
  spineMm?: number;
  expectedPageCount?: number;
  minBytes?: number;
  ptTolerance?: number;
  minCropMarkSlugMm?: number;
  expectedTextSnippets?: string[];
  forbiddenTextSnippets?: string[];
  expectedPageTextSnippets?: Record<number, string[]>;
}

export interface VerifiedPrintPdf {
  bytes: Buffer;
  pageCount: number;
  firstPageBoxes: {
    mediaBox: PdfBoxRect;
    bleedBox: PdfBoxRect;
    trimBox: PdfBoxRect;
  };
  extractedText?: string;
  extractedPages?: string[];
}

export async function verifyPdfBuffer(
  bytes: Buffer,
  options: PrintPdfExpectations,
): Promise<VerifiedPrintPdf> {
  const layoutMode: PdfLayoutMode = options.layoutMode ?? 'combined';
  const bleedMm = options.bleedMm ?? 0;
  const cropMarks = options.cropMarks ?? false;
  const minBytes = options.minBytes ?? (layoutMode === 'cover-wrap' ? 5_000 : 20_480);
  const tol = options.ptTolerance ?? (layoutMode === 'cover-wrap' ? 2.0 : 1.5);

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
  expect(pageCount).toBeGreaterThan(0);

  if (options.padToMultipleOf4) {
    expect(pageCount % 4, `Expected page count ${pageCount} to be a multiple of 4`).toBe(0);
  }
  if (layoutMode === 'cover-wrap') {
    expect(pageCount).toBe(1);
  }
  if (options.expectedPageCount !== undefined) {
    expect(pageCount).toBe(options.expectedPageCount);
  }

  const baseTrim = TRIM_DIMENSIONS_PT[options.format];
  const expectedTrimW =
    layoutMode === 'cover-wrap'
      ? 2 * baseTrim.width + mmToPt(options.spineMm ?? 0)
      : baseTrim.width;
  const expectedTrimH = baseTrim.height;
  const bleedPt = mmToPt(bleedMm);
  const minSlugPt = mmToPt(options.minCropMarkSlugMm ?? 6);

  let firstPageBoxes: VerifiedPrintPdf['firstPageBoxes'] | null = null;

  for (let index = 0; index < pageCount; index += 1) {
    const pdfPage = pdfDoc.getPage(index);
    const mediaBox = pdfPage.getMediaBox();
    const bleedBox = pdfPage.getBleedBox();
    const trimBox = pdfPage.getTrimBox();

    if (index === 0) {
      firstPageBoxes = { mediaBox, bleedBox, trimBox };
    }

    expect(
      Math.abs(trimBox.width - expectedTrimW),
      `Page ${index}: TrimBox width ${trimBox.width} expected ~${expectedTrimW}`,
    ).toBeLessThanOrEqual(tol);
    expect(
      Math.abs(trimBox.height - expectedTrimH),
      `Page ${index}: TrimBox height ${trimBox.height} expected ~${expectedTrimH}`,
    ).toBeLessThanOrEqual(tol);

    expect(
      Math.abs(bleedBox.width - (expectedTrimW + 2 * bleedPt)),
      `Page ${index}: BleedBox width ${bleedBox.width} expected ~${expectedTrimW + 2 * bleedPt}`,
    ).toBeLessThanOrEqual(tol);
    expect(
      Math.abs(bleedBox.height - (expectedTrimH + 2 * bleedPt)),
      `Page ${index}: BleedBox height ${bleedBox.height} expected ~${expectedTrimH + 2 * bleedPt}`,
    ).toBeLessThanOrEqual(tol);

    expect(
      Math.abs(trimBox.x - bleedBox.x - bleedPt),
      `Page ${index}: TrimBox.x (${trimBox.x}) - BleedBox.x (${bleedBox.x}) expected ~${bleedPt}`,
    ).toBeLessThanOrEqual(tol);
    expect(
      Math.abs(trimBox.y - bleedBox.y - bleedPt),
      `Page ${index}: TrimBox.y (${trimBox.y}) - BleedBox.y (${bleedBox.y}) expected ~${bleedPt}`,
    ).toBeLessThanOrEqual(tol);

    if (bleedMm > 0) {
      expect(bleedBox.width).toBeGreaterThan(trimBox.width);
      expect(bleedBox.height).toBeGreaterThan(trimBox.height);
      expect(trimBox.x).toBeGreaterThan(bleedBox.x);
      expect(trimBox.y).toBeGreaterThan(bleedBox.y);
    }

    if (cropMarks) {
      expect(mediaBox.width).toBeGreaterThan(bleedBox.width);
      expect(mediaBox.height).toBeGreaterThan(bleedBox.height);
      expect(bleedBox.x - mediaBox.x).toBeGreaterThanOrEqual(minSlugPt - tol);
      expect(bleedBox.y - mediaBox.y).toBeGreaterThanOrEqual(minSlugPt - tol);
      expect(
        mediaBox.x + mediaBox.width - (bleedBox.x + bleedBox.width),
      ).toBeGreaterThanOrEqual(minSlugPt - tol);
      expect(
        mediaBox.y + mediaBox.height - (bleedBox.y + bleedBox.height),
      ).toBeGreaterThanOrEqual(minSlugPt - tol);
    } else {
      expect(Math.abs(mediaBox.width - bleedBox.width)).toBeLessThanOrEqual(tol);
      expect(Math.abs(mediaBox.height - bleedBox.height)).toBeLessThanOrEqual(tol);
    }
  }

  let extractedText: string | undefined;
  let extractedPages: string[] | undefined;

  const needsTextExtraction =
    (options.expectedTextSnippets && options.expectedTextSnippets.length > 0) ||
    (options.forbiddenTextSnippets && options.forbiddenTextSnippets.length > 0) ||
    (options.expectedPageTextSnippets &&
      Object.keys(options.expectedPageTextSnippets).length > 0);

  if (needsTextExtraction) {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const proxy = await getDocumentProxy(new Uint8Array(bytes));
    try {
      const perPageResult = await extractText(proxy, { mergePages: false });
      const rawPages = Array.isArray(perPageResult.text)
        ? perPageResult.text
        : [perPageResult.text];
      extractedPages = rawPages.map((p) => p.replace(/\s+/g, ' ').trim());
      extractedText = extractedPages.join(' ');
    } finally {
      const destroyable = proxy as unknown as {
        destroy?: () => Promise<void> | void;
      };
      if (typeof destroyable.destroy === 'function') {
        await destroyable.destroy();
      }
    }

    for (const snippet of options.expectedTextSnippets ?? []) {
      expect(
        extractedText,
        `Expected PDF text to contain "${snippet}"`,
      ).toContain(snippet);
    }

    for (const forbidden of options.forbiddenTextSnippets ?? []) {
      expect(
        extractedText,
        `Expected PDF text NOT to contain "${forbidden}"`,
      ).not.toContain(forbidden);
    }

    if (options.expectedPageTextSnippets) {
      for (const [pageIdxStr, snippets] of Object.entries(
        options.expectedPageTextSnippets,
      )) {
        const pageIdx = Number(pageIdxStr);
        const pageText = extractedPages[pageIdx] ?? '';
        for (const snippet of snippets) {
          expect(
            pageText,
            `Expected PDF page ${pageIdx} to contain "${snippet}"`,
          ).toContain(snippet);
        }
      }
    }
  }

  return {
    bytes,
    pageCount,
    firstPageBoxes: firstPageBoxes!,
    extractedText,
    extractedPages,
  };
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

export interface PrintPdfDownloadOptions extends PrintPdfExpectations {
  expectedQueryParams?: Record<string, string>;
  expectedFilenamePattern?: RegExp;
  timeoutMs?: number;
}

export interface VerifiedPrintPdfDownload extends VerifiedPrintPdf {
  filename: string;
  capturedUrl?: string;
}

export async function expectPrintReadyPdfDownload(
  page: Page,
  triggerDownload: () => Promise<void>,
  options: PrintPdfDownloadOptions,
): Promise<VerifiedPrintPdfDownload> {
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

  let capturedUrl: string | undefined;
  if (capturedPdfResponses.length > 0) {
    const pdfRes = capturedPdfResponses[capturedPdfResponses.length - 1];
    capturedUrl = pdfRes.url();
    expect(pdfRes.status()).toBe(200);
    expectPdfApiHeaders(pdfRes.headers());
    const reqId = pdfRes.headers()['x-request-id'];
    expect(reqId, 'Expected X-Request-Id header on PDF response').toBeTruthy();
    expect(reqId).toMatch(UUID_OR_SAFE_REQUEST_ID_RE);

    if (options.expectedQueryParams) {
      const parsedUrl = new URL(capturedUrl);
      for (const [param, expectedVal] of Object.entries(
        options.expectedQueryParams,
      )) {
        expect(
          parsedUrl.searchParams.get(param),
          `Expected query param ${param}=${expectedVal} on ${capturedUrl}`,
        ).toBe(expectedVal);
      }
    }
  }

  const filename = download.suggestedFilename();
  expect(filename).toMatch(options.expectedFilenamePattern ?? /\.pdf$/i);

  const bytes = await readDownloadBytes(download);
  const verified = await verifyPdfBuffer(bytes, options);

  expect(page.url()).toBe(urlBefore);
  const bodyText = await page.locator('body').innerText();
  expect(bodyText).not.toContain('%PDF-');
  expect(bodyText).not.toContain('%PDF-1.7');

  return {
    ...verified,
    filename,
    capturedUrl,
  };
}

export interface ExtendedStoryRecordDto extends StoryRecordDto {
  referencePhotosPurgedAt?: string;
}

export interface ExtendedStorySummaryDto extends StorySummaryDto {
  referencePhotosCount?: number;
  referencePhotosPurgedAt?: string;
}

export interface ExtendedCreateStoryOptions extends CreateStoryApiOptions {
  themeId?: string;
  dedicationFrom?: string;
}

export async function createExtendedStoryViaApi(
  request: APIRequestContext,
  options: ExtendedCreateStoryOptions = {},
): Promise<ExtendedStoryRecordDto> {
  const photos =
    options.photos && options.photos.length > 0
      ? options.photos
      : [await getChildPhotoFixture(1)];

  const payload: Record<string, unknown> = {
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
  if (options.themeId !== undefined) {
    payload.themeId = options.themeId;
  }
  if (options.dedicationFrom !== undefined) {
    payload.dedicationFrom = options.dedicationFrom;
  }

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
  expect(res.status(), `POST /api/stories failed: ${await res.text()}`).toBe(201);
  expectRequestIdHeader(res);
  const json = (await res.json()) as { story: ExtendedStoryRecordDto };
  return json.story;
}

export async function uploadIllustrationViaApi(
  request: APIRequestContext,
  storyId: string,
  slot: 'cover' | number,
  file?: E2EFilePayload,
): Promise<{ slot: string; filename: string; assetUrl: string; updatedAt: string }> {
  const payloadFile =
    file ??
    (await getPrintReadyIllustrationPng(slot === 'cover' ? 'cover' : 'page'));

  const form = new FormData();
  const blobBytes = new Uint8Array(payloadFile.buffer);
  form.append(
    'file',
    new Blob([blobBytes], { type: payloadFile.mimeType }),
    payloadFile.name,
  );

  const res = await request.post(
    `/api/stories/${encodeURIComponent(storyId)}/illustrations/${slot}`,
    { multipart: form },
  );
  expect(
    res.status(),
    `POST illustrations/${slot} failed: ${await res.text()}`,
  ).toBe(200);
  expectRequestIdHeader(res);
  return (await res.json()) as {
    slot: string;
    filename: string;
    assetUrl: string;
    updatedAt: string;
  };
}

export async function completeManualStoryViaApi(
  request: APIRequestContext,
  storyId: string,
  file?: E2EFilePayload,
): Promise<ExtendedStoryRecordDto> {
  const initial = await fetchStoryViaApi(request, storyId);
  await uploadIllustrationViaApi(
    request,
    storyId,
    'cover',
    file ?? (await getPrintReadyIllustrationPng('cover')),
  );
  for (const pageItem of initial.pages) {
    await uploadIllustrationViaApi(
      request,
      storyId,
      pageItem.pageNumber,
      file ?? (await getPrintReadyIllustrationPng('page')),
    );
  }
  const refreshed = (await fetchStoryViaApi(
    request,
    storyId,
  )) as ExtendedStoryRecordDto;
  expect(refreshed.generationStage).toBe('complete');
  return refreshed;
}

export interface PreflightIssueDto {
  code: string;
  severity: 'error' | 'warning' | 'info';
  slot: string | number;
  message: string;
  details?: Record<string, unknown>;
}

export interface PreflightReportDto {
  storyId: string;
  format: BookFormat;
  checkedAt: string;
  readyForPrint: boolean;
  score: number;
  summary: {
    errors: number;
    warnings: number;
    info: number;
  };
  metrics: {
    storyPages: number;
    totalPdfPages: number;
    paddingNeededForMultipleOf4: number;
    expectedArtworkSlots: number;
    readyArtworkSlots: number;
    minEffectiveDpi: number | null;
  };
  issues: PreflightIssueDto[];
}

export type OrderStatusDto =
  | 'draft'
  | 'awaiting_payment'
  | 'paid'
  | 'awaiting_customer_approval'
  | 'approved_for_print'
  | 'preflight_passed'
  | 'preflight_failed'
  | 'submitted_to_printer'
  | 'in_production'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'refunded';

export type ActorKindDto =
  | 'customer'
  | 'admin'
  | 'agent'
  | 'system'
  | 'payment-webhook'
  | 'printer-webhook';

export interface ShippingAddressDto {
  recipientName: string;
  line1: string;
  line2?: string;
  postalCode: string;
  city: string;
  countryCode?: string;
  email: string;
  phone?: string;
}

export interface OrderRecordDto {
  id: string;
  orderNumber: string;
  version: number;
  storyId: string;
  bookFormat: BookFormat;
  quantity: number;
  currency: string;
  totalMinorUnits: number;
  status: OrderStatusDto;
  paymentStatus: 'unpaid' | 'pending' | 'paid' | 'refunded';
  paymentReference?: string;
  customerApprovedAt?: string;
  preflightPassed: boolean;
  preflightScore?: number;
  preflightStoryUpdatedAt?: string;
  printManifestDigest?: string;
  idempotencyKey?: string;
  processedEventIds?: string[];
  shippingAddress?: ShippingAddressDto;
  createdAt: string;
  updatedAt: string;
  auditLog: Array<{
    timestamp: string;
    from: OrderStatusDto;
    to: OrderStatusDto;
    actor: { kind: ActorKindDto; id: string };
    reason?: string;
  }>;
}

export interface PrintJobManifestDto {
  manifestVersion: number;
  orderId: string;
  orderNumber: string;
  storyId: string;
  bookFormat: BookFormat;
  quantity: number;
  pdfSpec: {
    bleedMm: number;
    cropMarks: boolean;
    padToMultipleOf4: boolean;
    layoutMode?: PdfLayoutMode;
    totalPdfPages: number;
  };
  pdfSha256: string;
  pdfBytesLength: number;
  preflightScore: number;
  preflightCheckedAt: string;
  shippingAddress: ShippingAddressDto;
  idempotencyKey: string;
  generatedAt: string;
}

export function buildTestShippingAddress(
  overrides: Partial<ShippingAddressDto> = {},
): ShippingAddressDto {
  return {
    recipientName: 'Anna Kowalska',
    line1: 'ul. Bajkowa 12/4',
    postalCode: '00-001',
    city: 'Warszawa',
    countryCode: 'PL',
    email: 'anna.kowalska@example.com',
    ...overrides,
  };
}

export async function createOrderViaApi(
  request: APIRequestContext,
  params: {
    storyId: string;
    bookFormat?: BookFormat;
    quantity?: number;
    totalMinorUnits?: number;
    shippingAddress?: ShippingAddressDto;
    idempotencyKey?: string;
  },
): Promise<{ status: number; order: OrderRecordDto; requestId: string }> {
  const headers: Record<string, string> = {};
  if (params.idempotencyKey) {
    headers['Idempotency-Key'] = params.idempotencyKey;
  }

  const body: Record<string, unknown> = {
    storyId: params.storyId,
    bookFormat: params.bookFormat ?? 'square',
    quantity: params.quantity ?? 1,
    totalMinorUnits: params.totalMinorUnits ?? 12900,
  };
  if (params.shippingAddress !== undefined) {
    body.shippingAddress = params.shippingAddress;
  }

  const res = await request.post('/api/orders', {
    headers,
    data: body,
  });
  expect(
    [200, 201],
    `POST /api/orders failed (${res.status()}): ${await res.text()}`,
  ).toContain(res.status());
  const requestId = expectRequestIdHeader(res);
  const json = (await res.json()) as { order: OrderRecordDto };
  expect(json.order.id).toBeTruthy();
  expect(json.order.orderNumber).toMatch(ORDER_NUMBER_RE);
  return { status: res.status(), order: json.order, requestId };
}

export async function transitionOrderViaApi(
  request: APIRequestContext,
  orderId: string,
  payload: {
    nextStatus: OrderStatusDto;
    actor: { kind: ActorKindDto; id: string };
    expectedVersion?: number;
    reason?: string;
    patch?: Record<string, unknown>;
  },
): Promise<APIResponse> {
  const body: Record<string, unknown> = {
    nextStatus: payload.nextStatus,
    to: payload.nextStatus,
    actor: payload.actor,
  };
  if (payload.expectedVersion !== undefined) {
    body.expectedVersion = payload.expectedVersion;
  }
  if (payload.reason !== undefined) {
    body.reason = payload.reason;
  }
  if (payload.patch !== undefined) {
    body.patch = payload.patch;
  }

  return request.post(
    `/api/orders/${encodeURIComponent(orderId)}/transitions`,
    {
      headers: getOpsAuthHeaders(),
      data: body,
    },
  );
}

export async function advanceOrderToPreflightPassed(
  request: APIRequestContext,
  orderId: string,
): Promise<{ order: OrderRecordDto; preflight: PreflightReportDto }> {
  const toPending = await transitionOrderViaApi(request, orderId, {
    nextStatus: 'awaiting_payment',
    actor: { kind: 'customer', id: 'e2e-customer' },
  });
  expect(
    toPending.status(),
    `draft -> awaiting_payment failed: ${await toPending.text()}`,
  ).toBe(200);

  const toPaid = await transitionOrderViaApi(request, orderId, {
    nextStatus: 'paid',
    actor: { kind: 'payment-webhook', id: 'e2e-pay-wh' },
    patch: { paymentReference: `pay_e2e_${Date.now()}` },
  });
  expect(
    toPaid.status(),
    `awaiting_payment -> paid failed: ${await toPaid.text()}`,
  ).toBe(200);

  const approveRes = await request.post(
    `/api/orders/${encodeURIComponent(orderId)}/approve`,
    {
      headers: getOpsAuthHeaders(),
      data: {
        actor: { kind: 'customer', id: 'e2e-customer' },
        reason: 'Zatwierdzenie podglądu do druku',
      },
    },
  );
  expect(
    approveRes.status(),
    `POST /approve failed: ${await approveRes.text()}`,
  ).toBe(200);

  const preflightRes = await request.post(
    `/api/orders/${encodeURIComponent(orderId)}/preflight`,
    {
      headers: getOpsAuthHeaders(),
    },
  );
  expect(
    preflightRes.status(),
    `POST /preflight failed: ${await preflightRes.text()}`,
  ).toBe(200);
  expectRequestIdHeader(preflightRes);

  const json = (await preflightRes.json()) as {
    order: OrderRecordDto;
    preflight: PreflightReportDto;
  };
  expect(json.preflight.readyForPrint).toBe(true);
  expect(json.order.status).toBe('preflight_passed');
  expect(json.order.preflightPassed).toBe(true);
  return json;
}

export async function runRetentionSweepViaApi(
  request: APIRequestContext,
  options: { dryRun: boolean },
): Promise<{ response: APIResponse; body: Record<string, unknown> }> {
  const futureIso = new Date(
    Date.now() + 400 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const response = await request.post('/api/ops/retention/sweep', {
    headers: getOpsAuthHeaders(),
    data: {
      dryRun: options.dryRun,
      ttlDays: 0,
      ttlHours: 0,
      now: futureIso,
    },
  });
  expect(
    response.status(),
    `POST /api/ops/retention/sweep failed: ${await response.text()}`,
  ).toBe(200);
  expectRequestIdHeader(response);
  const body = (await response.json()) as Record<string, unknown>;
  return { response, body };
}

export async function selectSeasonalThemeChip(
  page: Page,
): Promise<{ label: string; season: string; themeValue: string }> {
  const seasonalLocator = page.locator(
    '[data-testid="inspiration-chip"][data-season]:not([data-season="evergreen"])',
  );
  if ((await seasonalLocator.count()) === 0) {
    const toggleBtn = page.getByTestId('toggle-all-themes-btn');
    await expect(toggleBtn).toBeVisible();
    await toggleBtn.click();
  }
  const target = seasonalLocator.first();
  await expect(target).toBeVisible();
  const season = (await target.getAttribute('data-season')) ?? '';
  expect(season.length).toBeGreaterThan(0);
  expect(season).not.toBe('evergreen');
  const label = (await target.innerText()).trim();

  await target.click();
  const themeValue = await page.getByTestId('theme-input').inputValue();
  expect(themeValue.trim().length).toBeGreaterThan(5);

  return { label, season, themeValue };
}

export async function openPreflightPanel(page: Page): Promise<void> {
  const badge = page.getByTestId('preflight-badge');
  await expect(badge).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(
      async () => {
        const txt = (await badge.innerText()).trim();
        return txt.length > 0 && !/sprawdz|ładow/i.test(txt);
      },
      { timeout: 15_000 },
    )
    .toBe(true);

  const panel = page.getByTestId('preflight-panel');
  if (!(await panel.isVisible())) {
    await badge.click();
  }
  await expect(panel).toBeVisible({ timeout: 10_000 });
}

export async function triggerPrintReadyPdfDownload(
  page: Page,
  format: BookFormat,
  options: Omit<PrintPdfDownloadOptions, 'format'> = {},
): Promise<VerifiedPrintPdfDownload> {
  const btnTestId =
    format === 'square'
      ? 'download-pdf-print-square'
      : 'download-pdf-print-a4';
  const downloadBtn = page.getByTestId(btnTestId);

  if (!(await downloadBtn.isVisible())) {
    const toggle = page.getByTestId('print-ready-toggle');
    await expect(toggle).toBeVisible();
    await toggle.click();
  }
  await expect(downloadBtn).toBeVisible();

  return expectPrintReadyPdfDownload(
    page,
    async () => {
      await downloadBtn.click();
    },
    {
      format,
      bleedMm: options.bleedMm ?? 3,
      cropMarks: options.cropMarks ?? true,
      padToMultipleOf4: options.padToMultipleOf4 ?? true,
      ...options,
    },
  );
}

export async function purgeReferencePhotosViaUi(
  page: Page,
  storyId: string,
): Promise<{
  purged: boolean;
  storyId: string;
  deletedFiles: string[];
  purgedAt: string;
}> {
  const purgeBtn = page.getByTestId('rodo-purge-btn');
  if (!(await purgeBtn.isVisible())) {
    await page.goto(`/story/${encodeURIComponent(storyId)}?slide=1`, {
      waitUntil: 'domcontentloaded',
    });
  }
  await expect(purgeBtn).toBeVisible({ timeout: 15_000 });
  await purgeBtn.click();

  const confirmBtn = page.getByTestId('rodo-purge-confirm');
  await expect(confirmBtn).toBeVisible({ timeout: 10_000 });

  const responsePromise = page.waitForResponse(
    (res) =>
      res.request().method() === 'DELETE' &&
      new URL(res.url()).pathname ===
        `/api/stories/${encodeURIComponent(storyId)}/reference-photos`,
    { timeout: 15_000 },
  );

  await confirmBtn.click();
  const res = await responsePromise;
  expect(res.status()).toBe(200);
  const reqId = res.headers()['x-request-id'];
  expect(reqId).toBeTruthy();
  expect((res.headers()['cache-control'] ?? '').toLowerCase()).toContain(
    'no-store',
  );

  await expect(page.getByTestId('rodo-purged-badge')).toBeVisible({
    timeout: 10_000,
  });

  return (await res.json()) as {
    purged: boolean;
    storyId: string;
    deletedFiles: string[];
    purgedAt: string;
  };
}

export async function fillAndSubmitOrderDraftForm(
  page: Page,
  input: {
    recipientName: string;
    line1: string;
    postalCode: string;
    city: string;
    email: string;
    phone?: string;
  },
): Promise<{ orderNumber: string; orderId: string }> {
  const form = page.getByTestId('order-draft-form');
  if (!(await form.isVisible())) {
    const openBtn = page.getByTestId('order-draft-btn');
    await expect(openBtn).toBeVisible({ timeout: 15_000 });
    await openBtn.click();
  }
  await expect(form).toBeVisible({ timeout: 10_000 });

  const recipientField = form
    .locator(
      '[data-testid*="recipient"], [name="recipientName"], [autocomplete="name"]',
    )
    .or(form.getByLabel(/imię|odbiorc|nazwisk|recipient/i))
    .first();
  const line1Field = form
    .locator(
      '[data-testid*="line1"], [data-testid*="street"], [data-testid*="address"], [name="line1"], [name="street"], [autocomplete="street-address"]',
    )
    .or(form.getByLabel(/ulic|adres|street/i))
    .first();
  const postalField = form
    .locator(
      '[data-testid*="postal"], [name="postalCode"], [autocomplete="postal-code"]',
    )
    .or(form.getByLabel(/kod\s*poczt|postal/i))
    .first();
  const cityField = form
    .locator(
      '[data-testid*="city"], [name="city"], [autocomplete="address-level2"]',
    )
    .or(form.getByLabel(/miast|miejscow|city/i))
    .first();
  const emailField = form
    .locator('[data-testid*="email"], [name="email"], input[type="email"]')
    .or(form.getByLabel(/e-?mail/i))
    .first();

  await recipientField.fill(input.recipientName);
  await line1Field.fill(input.line1);
  await postalField.fill(input.postalCode);
  await cityField.fill(input.city);
  await emailField.fill(input.email);

  if (input.phone) {
    const phoneField = form
      .locator('[data-testid*="phone"], [name="phone"], input[type="tel"]')
      .or(form.getByLabel(/telefon|phone/i))
      .first();
    if ((await phoneField.count()) > 0 && (await phoneField.isVisible())) {
      await phoneField.fill(input.phone);
    }
  }

  const responsePromise = page.waitForResponse(
    (res) =>
      res.request().method() === 'POST' &&
      /\/api\/orders\/?$/.test(new URL(res.url()).pathname),
    { timeout: 15_000 },
  );

  await page.getByTestId('order-draft-submit').click();
  const res = await responsePromise;
  expect(
    [200, 201],
    `Order draft form POST /api/orders failed (${res.status()}): ${await res.text()}`,
  ).toContain(res.status());

  const json = (await res.json()) as { order: OrderRecordDto };
  const orderNumber = json.order.orderNumber;
  expect(orderNumber).toMatch(ORDER_NUMBER_RE);

  const createdBadge = page.getByTestId('order-created-number');
  await expect(createdBadge).toBeVisible({ timeout: 10_000 });
  await expect(createdBadge).toContainText(orderNumber);

  return { orderNumber, orderId: json.order.id };
}

export async function lookupOrderStatusViaUi(
  page: Page,
  orderNumber: string,
  verification: string,
  options: { containerTestId?: string; expectedStatus?: number } = {},
): Promise<Response> {
  const scope = options.containerTestId
    ? page.getByTestId(options.containerTestId)
    : page;

  await scope.getByTestId('order-lookup-number').fill(orderNumber);
  await scope.getByTestId('order-lookup-verification').fill(verification);

  const responsePromise = page.waitForResponse(
    (res) =>
      res.request().method() === 'POST' &&
      /\/api\/support\/order-status\/?$/.test(new URL(res.url()).pathname),
    { timeout: 15_000 },
  );

  await scope.getByTestId('order-lookup-submit').click();
  const res = await responsePromise;
  if (options.expectedStatus !== undefined) {
    expect(res.status()).toBe(options.expectedStatus);
  }
  return res;
}

export interface AgenticResourceTracker {
  trackStory(storyId: string): void;
  trackOrder(orderId: string): void;
  markSettingsMutated(): void;
  cleanup(): Promise<void>;
}

export function createAgenticTracker(
  page: Page,
  request: APIRequestContext,
): AgenticResourceTracker {
  const storyTracker = createStoryTracker(page, request);
  const trackedOrders = new Set<string>();
  let settingsMutated = false;

  page.on('response', (response: Response) => {
    if (
      response.request().method() === 'POST' &&
      /\/api\/orders\/?$/.test(new URL(response.url()).pathname) &&
      (response.status() === 201 || response.status() === 200)
    ) {
      void response
        .json()
        .then((body: unknown) => {
          if (body && typeof body === 'object') {
            const order = (body as { order?: { id?: unknown } }).order;
            if (order && typeof order.id === 'string' && order.id.length > 0) {
              trackedOrders.add(order.id);
            }
          }
        })
        .catch(() => {
          // Ignore response parse error if page closed early.
        });
    }
  });

  return {
    trackStory(storyId: string): void {
      storyTracker.track(storyId);
    },
    trackOrder(orderId: string): void {
      if (orderId.length > 0) {
        trackedOrders.add(orderId);
      }
    },
    markSettingsMutated(): void {
      settingsMutated = true;
    },
    async cleanup(): Promise<void> {
      const orderIds = Array.from(trackedOrders);
      trackedOrders.clear();
      for (const orderId of orderIds) {
        try {
          const res = await request.post(
            `/api/orders/${encodeURIComponent(orderId)}/cancel`,
            {
              headers: getOpsAuthHeaders(),
              data: {
                actor: { kind: 'admin', id: 'e2e-cleanup' },
                reason: 'E2E cleanup',
              },
            },
          );
          expect([200, 404, 409]).toContain(res.status());
        } catch {
          // Ignore network errors during teardown so story cleanup still runs.
        }
      }

      await storyTracker.cleanup();

      if (settingsMutated) {
        settingsMutated = false;
        await restoreDefaultSettings(request);
      }
    },
  };
}
