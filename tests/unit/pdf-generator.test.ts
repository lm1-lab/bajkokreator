import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { extractText } from 'unpdf';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as getPdfRoute } from '@/app/api/stories/[id]/pdf/route';
import {
  PDF_DIMENSIONS,
  generateStoryPdf,
  mmToPoints,
  type PdfAssetResolver,
} from '@/lib/pdf/generator';
import {
  computeCropMarkSegments,
  computeDefaultSpineMm,
  computePrepressBoxes,
  getFormatLayoutSpec,
} from '@/lib/pdf/layout-spec';
import { buildPolishStoryDraft } from '@/lib/polish/templates';
import { resetStorageRootCache } from '@/lib/storage/paths';
import { resetStoryRepository, saveStory } from '@/lib/storage/store';
import type { StoryInput, StoryRecord } from '@/lib/types/story';

async function createSamplePhotoBuffer(format: 'jpeg' | 'webp' = 'jpeg'): Promise<Buffer> {
  const base = sharp({
    create: {
      width: 240,
      height: 240,
      channels: 3,
      background: { r: 214, g: 168, b: 122 },
    },
  });
  return format === 'webp'
    ? base.webp({ quality: 80 }).toBuffer()
    : base.jpeg({ quality: 85 }).toBuffer();
}

function createSampleStory(overrides?: Partial<StoryRecord>): StoryRecord {
  const input: StoryInput = {
    childName: 'Zosia',
    childAge: 5,
    gender: 'girl',
    companion: 'rudy kotek Mruczek',
    theme: 'Zażółć gęślą jaźń — wyprawa po magiczny klucz świetlików',
    artStyle: 'watercolor',
    mood: 'warm-cozy',
    pageCount: 10,
    dedicationFrom: 'Mama i Tata',
  };
  const draft = buildPolishStoryDraft(input);
  const now = new Date().toISOString();

  return {
    id: 'zosia-pdf-test-01',
    createdAt: now,
    updatedAt: now,
    provider: 'demo',
    generationMode: 'full',
    generationStage: 'complete',
    bookFormat: 'square',
    input,
    title: 'Zażółć gęślą jaźń — Przygoda Zosi',
    subtitle: 'Łąka pełna świetlików, ćmy, Źródełko i Śpiew',
    dedicationText:
      'Kochana Zosiu, niech ta bajka przypomina Ci o odwadze: zażółć gęślą jaźń oraz ĄĆĘŁŃÓŚŹŻ!',
    backCoverBlurb:
      'Ciepła książeczka dla Zosi z polskimi znakami: zażółć gęślą jaźń, ćma, łódź, źródło.',
    characterBible: draft.characterBible,
    coverPrompt: draft.coverPrompt,
    coverFilename: null,
    demoCoverPath: '/demo-art/cover.jpg',
    coverStatus: 'ready',
    referencePhotos: ['ref-1.jpg'],
    pages: draft.pages.map((p, idx) => ({
      pageNumber: p.pageNumber,
      chapterTitle: idx === 0 ? 'Rozdział 1: Zażółć gęślą jaźń' : p.chapterTitle,
      text:
        idx === 0
          ? `${p.text} Zażółć gęślą jaźń — ą ć ę ł ń ó ś ź ż Ą Ć Ę Ł Ń Ó Ś Ź Ż.`
          : p.text,
      imagePrompt: p.imagePrompt,
      imageFilename: null,
      demoAssetPath: `/demo-art/page-${String(p.pageNumber).padStart(2, '0')}.jpg`,
      imageStatus: 'ready',
    })),
    modelsUsed: {
      textModel: 'demo-polish-storyteller-v1',
      imageModel: 'demo-watercolor-plates-v1',
    },
    ...overrides,
  };
}

describe('generateStoryPdf', () => {
  it('generates a deterministic 13-page Square (21x21 cm) PDF with Polish diacritics and explicit TrimBox at bleedMm=0', async () => {
    const story = createSampleStory();
    const photoBuffer = await createSamplePhotoBuffer('jpeg');
    const resolver: PdfAssetResolver = {
      async readStoryAsset(_id, filename) {
        return filename === 'ref-1.jpg' ? photoBuffer : null;
      },
    };

    const bytes = await generateStoryPdf(story, 'square', resolver);
    expect(bytes.byteLength).toBeGreaterThan(20_000);
    expect(Buffer.from(bytes.slice(0, 5)).toString('ascii')).toBe('%PDF-');

    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBe(13);

    for (const pageIdx of [0, 1, 2, 12]) {
      const page = loaded.getPage(pageIdx);
      expect(page.getWidth()).toBeCloseTo(PDF_DIMENSIONS.square.width, 1);
      expect(page.getHeight()).toBeCloseTo(PDF_DIMENSIONS.square.height, 1);

      const trimBox = page.getTrimBox();
      expect(trimBox.x).toBeCloseTo(0, 1);
      expect(trimBox.y).toBeCloseTo(0, 1);
      expect(trimBox.width).toBeCloseTo(PDF_DIMENSIONS.square.width, 1);
      expect(trimBox.height).toBeCloseTo(PDF_DIMENSIONS.square.height, 1);
    }

    const extracted = await extractText(new Uint8Array(bytes), { mergePages: true });
    const fullText = Array.isArray(extracted.text)
      ? extracted.text.join('\n')
      : extracted.text;
    expect(fullText.toLowerCase()).toContain('zażółć gęślą jaźń');
    expect(fullText).toContain('Zosia');
    expect(fullText).toContain('Mama i Tata');
  });

  it('generates a 13-page A4 landscape PDF preserving Polish diacritics, explicit TrimBox, and WebP transcoding', async () => {
    const webpBuffer = await createSamplePhotoBuffer('webp');
    const story = createSampleStory({
      bookFormat: 'a4-landscape',
      referencePhotos: ['ref-1.webp'],
      pages: createSampleStory().pages.map((p) =>
        p.pageNumber === 1 ? { ...p, imageFilename: 'page-1.webp' } : p,
      ),
    });

    const resolver: PdfAssetResolver = {
      async readStoryAsset(_id, filename) {
        if (filename === 'ref-1.webp' || filename === 'page-1.webp') {
          return webpBuffer;
        }
        return null;
      },
    };

    const bytes = await generateStoryPdf(story, 'a4-landscape', resolver);
    expect(Buffer.from(bytes.slice(0, 5)).toString('ascii')).toBe('%PDF-');

    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBe(13);

    const page = loaded.getPage(2);
    expect(page.getWidth()).toBeCloseTo(PDF_DIMENSIONS['a4-landscape'].width, 1);
    expect(page.getHeight()).toBeCloseTo(PDF_DIMENSIONS['a4-landscape'].height, 1);

    const trimBox = page.getTrimBox();
    expect(trimBox.x).toBeCloseTo(0, 1);
    expect(trimBox.y).toBeCloseTo(0, 1);
    expect(trimBox.width).toBeCloseTo(PDF_DIMENSIONS['a4-landscape'].width, 1);
    expect(trimBox.height).toBeCloseTo(PDF_DIMENSIONS['a4-landscape'].height, 1);

    const extracted = await extractText(new Uint8Array(bytes), { mergePages: true });
    const fullText = Array.isArray(extracted.text)
      ? extracted.text.join('\n')
      : extracted.text;
    expect(fullText.toLowerCase()).toContain('zażółć gęślą jaźń');
  });

  it('gracefully handles missing images and strips unsupported emojis while preserving Polish diacritics', async () => {
    const story = createSampleStory({
      demoCoverPath: null,
      coverFilename: null,
      referencePhotos: [],
      title: 'Bajka z iskierką ✨🌟 dla Zosi',
      pages: createSampleStory().pages.slice(0, 4).map((p, i) => ({
        ...p,
        pageNumber: i + 1,
        demoAssetPath: null,
        imageFilename: null,
        text: `Strona ${i + 1}: 🦊 Zażółć gęślą jaźń i uśmiech!`,
      })),
    });
    story.input.pageCount = 4;

    const resolver: PdfAssetResolver = {
      async readStoryAsset() {
        return null;
      },
    };

    const bytes = await generateStoryPdf(story, 'square', resolver);
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBe(7); // 4 story pages + cover + dedication + back cover

    const extracted = await extractText(new Uint8Array(bytes), { mergePages: true });
    const fullText = Array.isArray(extracted.text)
      ? extracted.text.join('\n')
      : extracted.text;
    expect(fullText.toLowerCase()).toContain('zażółć gęślą jaźń');
    expect(fullText).not.toContain('✨');
    expect(fullText).not.toContain('🌟');
    expect(fullText).not.toContain('🦊');
  });

  it('supports print-ready 3mm bleed + slug-margin crop marks strictly outside BleedBox + multiple-of-4 padding', async () => {
    const story = createSampleStory();
    const photoBuffer = await createSamplePhotoBuffer('jpeg');
    const resolver: PdfAssetResolver = {
      async readStoryAsset(_id, filename) {
        return filename === 'ref-1.jpg' ? photoBuffer : null;
      },
    };

    const bytes = await generateStoryPdf(story, 'square', resolver, {
      bleedMm: 3,
      cropMarks: true,
      padToMultipleOf4: true,
    });

    const loaded = await PDFDocument.load(bytes);
    // 13 base pages padded to 16 (divisible by 4) via 3 editorial endpaper pages
    expect(loaded.getPageCount()).toBe(16);
    expect(loaded.getPageCount() % 4).toBe(0);

    const spec = getFormatLayoutSpec('square');
    expect(spec.cropMarkSlugMm).toBeGreaterThanOrEqual(6);

    const bleedPt = mmToPoints(3);
    const slugPt = mmToPoints(spec.cropMarkSlugMm);
    const firstPage = loaded.getPage(0);

    // MediaBox = trim + 2*bleed + 2*slug
    expect(firstPage.getWidth()).toBeCloseTo(spec.trimWidthPt + bleedPt * 2 + slugPt * 2, 1);
    expect(firstPage.getHeight()).toBeCloseTo(spec.trimHeightPt + bleedPt * 2 + slugPt * 2, 1);

    // BleedBox = [slug, slug, trim + 2*bleed, trim + 2*bleed]
    const bleedBox = firstPage.getBleedBox();
    expect(bleedBox.x).toBeCloseTo(slugPt, 1);
    expect(bleedBox.y).toBeCloseTo(slugPt, 1);
    expect(bleedBox.width).toBeCloseTo(spec.trimWidthPt + bleedPt * 2, 1);
    expect(bleedBox.height).toBeCloseTo(spec.trimHeightPt + bleedPt * 2, 1);

    // TrimBox = [slug + bleed, slug + bleed, trim, trim]
    const trimBox = firstPage.getTrimBox();
    expect(trimBox.x).toBeCloseTo(slugPt + bleedPt, 1);
    expect(trimBox.y).toBeCloseTo(slugPt + bleedPt, 1);
    expect(trimBox.width).toBeCloseTo(spec.trimWidthPt, 1);
    expect(trimBox.height).toBeCloseTo(spec.trimHeightPt, 1);

    // Strict nesting invariant: MediaBox > BleedBox > TrimBox
    expect(firstPage.getWidth()).toBeGreaterThan(bleedBox.width);
    expect(bleedBox.width).toBeGreaterThan(trimBox.width);
    expect(trimBox.x).toBeGreaterThan(bleedBox.x);
    expect(bleedBox.x).toBeGreaterThan(0);

    // Verify mathematical invariant: every crop mark segment sits strictly outside BleedBox and inside MediaBox
    const boxes = computePrepressBoxes(spec.trimWidthPt, spec.trimHeightPt, bleedPt, slugPt);
    const segments = computeCropMarkSegments(spec.trimWidthPt, spec.trimHeightPt, bleedPt, slugPt);
    expect(segments.length).toBe(8);
    for (const seg of segments) {
      for (const [x, y] of [
        [seg.x1, seg.y1],
        [seg.x2, seg.y2],
      ]) {
        expect(x).toBeGreaterThan(0);
        expect(x).toBeLessThan(boxes.mediaBox.width);
        expect(y).toBeGreaterThan(0);
        expect(y).toBeLessThan(boxes.mediaBox.height);

        const insideBleedX =
          x >= boxes.bleedBox.x && x <= boxes.bleedBox.x + boxes.bleedBox.width;
        const insideBleedY =
          y >= boxes.bleedBox.y && y <= boxes.bleedBox.y + boxes.bleedBox.height;
        expect(insideBleedX && insideBleedY).toBe(false);
      }
    }
  });

  it('preserves MediaBox === BleedBox when bleedMm=3 and cropMarks=false', async () => {
    const story = createSampleStory();
    const resolver: PdfAssetResolver = {
      async readStoryAsset() {
        return null;
      },
    };

    const bytes = await generateStoryPdf(story, 'square', resolver, {
      bleedMm: 3,
      cropMarks: false,
    });

    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBe(13);

    const spec = getFormatLayoutSpec('square');
    const bleedPt = mmToPoints(3);
    const firstPage = loaded.getPage(0);

    expect(firstPage.getWidth()).toBeCloseTo(spec.trimWidthPt + bleedPt * 2, 1);
    expect(firstPage.getHeight()).toBeCloseTo(spec.trimHeightPt + bleedPt * 2, 1);

    const bleedBox = firstPage.getBleedBox();
    expect(bleedBox.x).toBeCloseTo(0, 1);
    expect(bleedBox.y).toBeCloseTo(0, 1);
    expect(bleedBox.width).toBeCloseTo(spec.trimWidthPt + bleedPt * 2, 1);
    expect(bleedBox.height).toBeCloseTo(spec.trimHeightPt + bleedPt * 2, 1);

    const trimBox = firstPage.getTrimBox();
    expect(trimBox.x).toBeCloseTo(bleedPt, 1);
    expect(trimBox.y).toBeCloseTo(bleedPt, 1);
    expect(trimBox.width).toBeCloseTo(spec.trimWidthPt, 1);
    expect(trimBox.height).toBeCloseTo(spec.trimHeightPt, 1);
  });

  it('supports cropMarks=true even when bleedMm=0 by expanding slug margin cleanly', async () => {
    const story = createSampleStory({
      pages: createSampleStory().pages.slice(0, 4).map((p, idx) => ({ ...p, pageNumber: idx + 1 })),
    });
    story.input.pageCount = 4;

    const bytes = await generateStoryPdf(story, 'square', { async readStoryAsset() { return null; } }, {
      bleedMm: 0,
      cropMarks: true,
    });
    const loaded = await PDFDocument.load(bytes);
    const spec = getFormatLayoutSpec('square');
    const slugPt = mmToPoints(spec.cropMarkSlugMm);
    const page = loaded.getPage(0);

    expect(page.getWidth()).toBeCloseTo(spec.trimWidthPt + slugPt * 2, 1);
    expect(page.getBleedBox().x).toBeCloseTo(slugPt, 1);
    expect(page.getTrimBox().x).toBeCloseTo(slugPt, 1);
    expect(page.getTrimBox().width).toBeCloseTo(spec.trimWidthPt, 1);
  });

  it('uses Polish Genitive grammar on dedication and endpaper pages (dla Zosi / dla Antosia)', async () => {
    const girlStory = createSampleStory({
      input: {
        ...createSampleStory().input,
        childName: 'Zosia',
        gender: 'girl',
        dedicationFrom: undefined,
      },
      referencePhotos: [],
    });

    const girlBytes = await generateStoryPdf(
      girlStory,
      'square',
      { async readStoryAsset() { return null; } },
      { padToMultipleOf4: true },
    );
    const girlExtracted = await extractText(new Uint8Array(girlBytes), { mergePages: true });
    const girlText = Array.isArray(girlExtracted.text)
      ? girlExtracted.text.join('\n')
      : girlExtracted.text;

    expect(girlText).toContain('bajki dla Zosi');
    expect(girlText).toContain('Dla Zosi');
    expect(girlText).not.toContain('bajki dla Zosia');
    expect(girlText).not.toContain('Dla Zosia');

    const boyStory = createSampleStory({
      input: {
        ...createSampleStory().input,
        childName: 'Antoś',
        gender: 'boy',
        dedicationFrom: '',
      },
      referencePhotos: [],
    });
    const boyBytes = await generateStoryPdf(
      boyStory,
      'square',
      { async readStoryAsset() { return null; } },
      { padToMultipleOf4: true },
    );
    const boyExtracted = await extractText(new Uint8Array(boyBytes), { mergePages: true });
    const boyText = Array.isArray(boyExtracted.text)
      ? boyExtracted.text.join('\n')
      : boyExtracted.text;

    expect(boyText).toContain('bajki dla Antosia');
    expect(boyText).toContain('Dla Antosia');
    expect(boyText).not.toContain('bajki dla Antoś');
    expect(boyText).not.toContain('Dla Antoś');
  });

  it('supports POD layoutMode="interior" with and without multiple-of-4 padding', async () => {
    const story = createSampleStory({ referencePhotos: [] });
    const resolver: PdfAssetResolver = { async readStoryAsset() { return null; } };

    // 10 story pages -> 11 interior pages (1 dedication + 10 story pages, no front/back covers)
    const unpaddedBytes = await generateStoryPdf(story, 'square', resolver, {
      layoutMode: 'interior',
      bleedMm: 3,
      cropMarks: false,
      padToMultipleOf4: false,
    });
    const unpaddedDoc = await PDFDocument.load(unpaddedBytes);
    expect(unpaddedDoc.getPageCount()).toBe(11);

    const spec = getFormatLayoutSpec('square');
    const bleedPt = mmToPoints(3);
    expect(unpaddedDoc.getPage(0).getTrimBox().width).toBeCloseTo(spec.trimWidthPt, 1);
    expect(unpaddedDoc.getPage(0).getBleedBox().width).toBeCloseTo(
      spec.trimWidthPt + bleedPt * 2,
      1,
    );

    // Padded: 11 -> 12 pages (1 endpaper added)
    const paddedBytes = await generateStoryPdf(story, 'square', resolver, {
      layoutMode: 'interior',
      padToMultipleOf4: true,
    });
    const paddedDoc = await PDFDocument.load(paddedBytes);
    expect(paddedDoc.getPageCount()).toBe(12);
    expect(paddedDoc.getPageCount() % 4).toBe(0);
  });

  it('supports POD layoutMode="cover-wrap" with explicit and default spineMm and outside-bleed fold marks', async () => {
    const story = createSampleStory({ referencePhotos: [] });
    const resolver: PdfAssetResolver = { async readStoryAsset() { return null; } };
    const spec = getFormatLayoutSpec('square');

    // Explicit spineMm = 10, bleedMm = 3, cropMarks = true
    const explicitSpineMm = 10;
    const explicitBytes = await generateStoryPdf(story, 'square', resolver, {
      layoutMode: 'cover-wrap',
      spineMm: explicitSpineMm,
      bleedMm: 3,
      cropMarks: true,
    });
    const explicitDoc = await PDFDocument.load(explicitBytes);
    expect(explicitDoc.getPageCount()).toBe(1);

    const spreadPage = explicitDoc.getPage(0);
    const bleedPt = mmToPoints(3);
    const slugPt = mmToPoints(spec.cropMarkSlugMm);
    const spinePt = mmToPoints(explicitSpineMm);
    const expectedTrimW = spec.trimWidthPt * 2 + spinePt;
    const expectedTrimH = spec.trimHeightPt;

    const trimBox = spreadPage.getTrimBox();
    expect(trimBox.x).toBeCloseTo(slugPt + bleedPt, 1);
    expect(trimBox.y).toBeCloseTo(slugPt + bleedPt, 1);
    expect(trimBox.width).toBeCloseTo(expectedTrimW, 1);
    expect(trimBox.height).toBeCloseTo(expectedTrimH, 1);

    const bleedBox = spreadPage.getBleedBox();
    expect(bleedBox.x).toBeCloseTo(slugPt, 1);
    expect(bleedBox.y).toBeCloseTo(slugPt, 1);
    expect(bleedBox.width).toBeCloseTo(expectedTrimW + bleedPt * 2, 1);
    expect(bleedBox.height).toBeCloseTo(expectedTrimH + bleedPt * 2, 1);

    expect(spreadPage.getWidth()).toBeCloseTo(expectedTrimW + bleedPt * 2 + slugPt * 2, 1);
    expect(spreadPage.getHeight()).toBeCloseTo(expectedTrimH + bleedPt * 2 + slugPt * 2, 1);

    // Check spine fold segments sit strictly outside BleedBox
    const foldSegments = computeCropMarkSegments(expectedTrimW, expectedTrimH, bleedPt, slugPt, [
      spec.trimWidthPt,
      spec.trimWidthPt + spinePt,
    ]).filter((s) => s.kind === 'fold');
    expect(foldSegments.length).toBe(4);
    for (const seg of foldSegments) {
      expect(seg.y2 < bleedBox.y || seg.y1 > bleedBox.y + bleedBox.height).toBe(true);
    }

    const extracted = await extractText(new Uint8Array(explicitBytes), { mergePages: true });
    const fullText = Array.isArray(extracted.text)
      ? extracted.text.join('\n')
      : extracted.text;
    expect(fullText).toContain('O TEJ KSIĄŻECZCE');
    expect(fullText).toContain('Wydano w pracowni BajkoKreator');
    expect(fullText).toContain('PRACOWNIA BAJKOKREATOR');
    expect(fullText.toLowerCase()).toContain('zażółć gęślą jaźń');

    // Default spineMm calculation (>= 6mm)
    const defaultBytes = await generateStoryPdf(story, 'square', resolver, {
      layoutMode: 'cover-wrap',
    });
    const defaultDoc = await PDFDocument.load(defaultBytes);
    expect(defaultDoc.getPageCount()).toBe(1);
    const defaultSpineMm = computeDefaultSpineMm(story.pages.length);
    expect(defaultSpineMm).toBeGreaterThanOrEqual(6);
    expect(defaultDoc.getPage(0).getTrimBox().width).toBeCloseTo(
      spec.trimWidthPt * 2 + mmToPoints(defaultSpineMm),
      1,
    );
  });
});

describe('GET /api/stories/[id]/pdf validation & POD modes', () => {
  let tempDataDir = '';
  const originalDataDir = process.env.BAJKOKREATOR_DATA_DIR;
  const savedStory = createSampleStory({
    id: 'zosia-pdf-route-test-01',
    referencePhotos: [],
  });

  beforeAll(async () => {
    tempDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bajkokreator-pdf-route-'));
    process.env.BAJKOKREATOR_DATA_DIR = tempDataDir;
    resetStorageRootCache();
    resetStoryRepository();
    await saveStory(savedStory);
  });

  afterAll(async () => {
    if (originalDataDir === undefined) {
      delete process.env.BAJKOKREATOR_DATA_DIR;
    } else {
      process.env.BAJKOKREATOR_DATA_DIR = originalDataDir;
    }
    resetStorageRootCache();
    resetStoryRepository();
    if (tempDataDir) {
      await fs.rm(tempDataDir, { recursive: true, force: true });
    }
  });

  it('rejects empty/whitespace bleedMm= with 400 INVALID_BLEED', async () => {
    for (const query of ['format=square&bleedMm=', 'format=square&bleedMm=%20%20']) {
      const res = await getPdfRoute(
        new Request(`http://localhost/api/stories/${savedStory.id}/pdf?${query}`),
        { params: Promise.resolve({ id: savedStory.id }) },
      );
      expect(res.status).toBe(400);
      expect(res.headers.get('cache-control')).toContain('no-store');
      const body = await res.json();
      expect(body.code).toBe('INVALID_BLEED');
    }
  });

  it('rejects invalid or empty layoutMode with 400 INVALID_LAYOUT_MODE', async () => {
    for (const query of ['format=square&layoutMode=magazine', 'format=square&layoutMode=']) {
      const res = await getPdfRoute(
        new Request(`http://localhost/api/stories/${savedStory.id}/pdf?${query}`),
        { params: Promise.resolve({ id: savedStory.id }) },
      );
      expect(res.status).toBe(400);
      expect(res.headers.get('cache-control')).toContain('no-store');
      const body = await res.json();
      expect(body.code).toBe('INVALID_LAYOUT_MODE');
    }
  });

  it('rejects empty, non-numeric, or out-of-range spineMm with 400 INVALID_SPINE', async () => {
    for (const value of ['', '%20', 'abc', '0', '2', '80']) {
      const res = await getPdfRoute(
        new Request(
          `http://localhost/api/stories/${savedStory.id}/pdf?format=square&layoutMode=cover-wrap&spineMm=${value}`,
        ),
        { params: Promise.resolve({ id: savedStory.id }) },
      );
      expect(res.status).toBe(400);
      expect(res.headers.get('cache-control')).toContain('no-store');
      const body = await res.json();
      expect(body.code).toBe('INVALID_SPINE');
    }
  });

  it('returns valid PDFs for combined, interior, and cover-wrap modes with backwards-compatible filenames', async () => {
    // 1. Default combined mode keeps exact -print-3mm.pdf filename
    const combinedRes = await getPdfRoute(
      new Request(
        `http://localhost/api/stories/${savedStory.id}/pdf?format=square&bleedMm=3&cropMarks=true`,
      ),
      { params: Promise.resolve({ id: savedStory.id }) },
    );
    expect(combinedRes.status).toBe(200);
    expect(combinedRes.headers.get('x-pdf-layout-mode')).toBe('combined');
    expect(combinedRes.headers.get('content-disposition')).toContain('-square-print-3mm.pdf');

    // 2. Interior mode with padToMultipleOf4=true -> 12 pages
    const interiorRes = await getPdfRoute(
      new Request(
        `http://localhost/api/stories/${savedStory.id}/pdf?format=square&layoutMode=interior&padToMultipleOf4=true`,
      ),
      { params: Promise.resolve({ id: savedStory.id }) },
    );
    expect(interiorRes.status).toBe(200);
    expect(interiorRes.headers.get('x-pdf-layout-mode')).toBe('interior');
    expect(interiorRes.headers.get('content-disposition')).toContain('-square-interior.pdf');
    const interiorDoc = await PDFDocument.load(new Uint8Array(await interiorRes.arrayBuffer()));
    expect(interiorDoc.getPageCount()).toBe(12);

    // 3. Cover-wrap mode with spineMm=10 & bleedMm=3 & cropMarks=true -> 1 spread page
    const coverWrapRes = await getPdfRoute(
      new Request(
        `http://localhost/api/stories/${savedStory.id}/pdf?format=square&layoutMode=cover-wrap&spineMm=10&bleedMm=3&cropMarks=true`,
      ),
      { params: Promise.resolve({ id: savedStory.id }) },
    );
    expect(coverWrapRes.status).toBe(200);
    expect(coverWrapRes.headers.get('x-pdf-layout-mode')).toBe('cover-wrap');
    expect(coverWrapRes.headers.get('content-disposition')).toContain(
      '-square-cover-wrap-print-3mm.pdf',
    );
    const coverWrapDoc = await PDFDocument.load(new Uint8Array(await coverWrapRes.arrayBuffer()));
    expect(coverWrapDoc.getPageCount()).toBe(1);
  });
});
