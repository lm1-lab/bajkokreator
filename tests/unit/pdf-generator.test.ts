import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { extractText } from 'unpdf';
import { describe, expect, it } from 'vitest';
import {
  PDF_DIMENSIONS,
  generateStoryPdf,
  type PdfAssetResolver,
} from '@/lib/pdf/generator';
import { buildPolishStoryDraft } from '@/lib/polish/templates';
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
  return format === 'webp' ? base.webp({ quality: 80 }).toBuffer() : base.jpeg({ quality: 85 }).toBuffer();
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
  it('generates a deterministic 13-page Square (21x21 cm) PDF with Polish diacritics', async () => {
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

    const firstPage = loaded.getPage(0);
    expect(firstPage.getWidth()).toBeCloseTo(PDF_DIMENSIONS.square.width, 1);
    expect(firstPage.getHeight()).toBeCloseTo(PDF_DIMENSIONS.square.height, 1);

    const extracted = await extractText(new Uint8Array(bytes), { mergePages: true });
    const fullText = Array.isArray(extracted.text)
      ? extracted.text.join('\n')
      : extracted.text;
    expect(fullText.toLowerCase()).toContain('zażółć gęślą jaźń');
    expect(fullText).toContain('Zosia');
    expect(fullText).toContain('Mama i Tata');
  });

  it('generates a 13-page A4 landscape PDF preserving Polish diacritics and WebP transcoding', async () => {
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

    const extracted = await extractText(new Uint8Array(bytes), { mergePages: true });
    const fullText = Array.isArray(extracted.text)
      ? extracted.text.join('\n')
      : extracted.text;
    expect(fullText.toLowerCase()).toContain('zażółć gęślą jaźń');
  });

  it('gracefully handles missing images and unsupported emojis without throwing', async () => {
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
  });
});
