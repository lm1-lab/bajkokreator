import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as getSettings, PATCH as patchSettings } from '@/app/api/settings/route';
import { GET as getStories, POST as postStories } from '@/app/api/stories/route';
import {
  DELETE as deleteStoryRoute,
  GET as getStoryRoute,
  PATCH as patchStoryRoute,
} from '@/app/api/stories/[id]/route';
import { GET as getAssetRoute } from '@/app/api/stories/[id]/assets/[filename]/route';
import { POST as continueStoryRoute } from '@/app/api/stories/[id]/continue/route';
import { POST as uploadIllustrationRoute } from '@/app/api/stories/[id]/illustrations/[slot]/route';
import { PATCH as patchPageRoute } from '@/app/api/stories/[id]/pages/[pageNumber]/route';
import { GET as getPdfRoute } from '@/app/api/stories/[id]/pdf/route';
import { GET as getPreflightRoute } from '@/app/api/stories/[id]/preflight/route';
import { DELETE as purgeReferencePhotosRoute } from '@/app/api/stories/[id]/reference-photos/route';
import { resetStorageRootCache } from '@/lib/storage/paths';
import type { StoryRecord } from '@/lib/types/story';

let tempDataDir = '';
const originalDataDir = process.env.BAJKOKREATOR_DATA_DIR;

async function makeJpegFile(name = 'photo.jpg'): Promise<File> {
  const buf = await sharp({
    create: {
      width: 120,
      height: 120,
      channels: 3,
      background: { r: 224, g: 180, b: 140 },
    },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
  return new File([new Uint8Array(buf)], name, { type: 'image/jpeg' });
}

beforeAll(async () => {
  tempDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bajkokreator-api-test-'));
  process.env.BAJKOKREATOR_DATA_DIR = tempDataDir;
  resetStorageRootCache();
});

afterAll(async () => {
  if (originalDataDir === undefined) {
    delete process.env.BAJKOKREATOR_DATA_DIR;
  } else {
    process.env.BAJKOKREATOR_DATA_DIR = originalDataDir;
  }
  resetStorageRootCache();
  if (tempDataDir) {
    await fs.rm(tempDataDir, { recursive: true, force: true });
  }
});

describe('API Routes integration', () => {
  it('supports full story lifecycle: create -> list -> get -> edit page -> upload art -> binary PDF -> delete', async () => {
    const form = new FormData();
    form.append(
      'payload',
      JSON.stringify({
        childName: 'Zosia',
        childAge: 5,
        gender: 'girl',
        companion: 'rudy kotek Mruczek',
        theme: 'Wyprawa do lasu świetlików',
        artStyle: 'watercolor',
        mood: 'warm-cozy',
        pageCount: 10,
        provider: 'demo',
        generationMode: 'preview-first',
        bookFormat: 'square',
      }),
    );
    form.append('photos', await makeJpegFile('zosia.jpg'));

    const createRes = await postStories(
      new Request('http://localhost/api/stories', {
        method: 'POST',
        body: form,
      }),
    );
    expect(createRes.status).toBe(201);
    const createdJson = (await createRes.json()) as { story: StoryRecord };
    const story = createdJson.story;
    expect(story.id).toBeTruthy();
    expect(story.generationStage).toBe('preview');
    expect(story.pages).toHaveLength(10);
    expect(story.pages[0].imageStatus).toBe('ready');
    expect(story.pages[1].imageStatus).toBe('pending');

    // Continue preview-first story
    const continueRes = await continueStoryRoute(
      new Request(`http://localhost/api/stories/${story.id}/continue`, { method: 'POST' }),
      { params: Promise.resolve({ id: story.id }) },
    );
    expect(continueRes.status).toBe(200);
    const continuedJson = (await continueRes.json()) as {
      story: StoryRecord;
      generatedPages: number[];
    };
    expect(continuedJson.generatedPages).toHaveLength(9);
    expect(continuedJson.story.generationStage).toBe('complete');

    // List stories
    const listRes = await getStories();
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as {
      stories: Array<{ id: string }>;
      storageMode: string;
    };
    expect(listJson.stories.some((s) => s.id === story.id)).toBe(true);

    // Get story
    const getRes = await getStoryRoute(
      new Request(`http://localhost/api/stories/${story.id}`),
      { params: Promise.resolve({ id: story.id }) },
    );
    expect(getRes.status).toBe(200);

    // Patch page 1 with Polish diacritics
    const patchPageRes = await patchPageRoute(
      new Request(`http://localhost/api/stories/${story.id}/pages/1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: 'Zażółć gęślą jaźń — Zosia wyruszyła w drogę.',
        }),
      }),
      { params: Promise.resolve({ id: story.id, pageNumber: '1' }) },
    );
    expect(patchPageRes.status).toBe(200);

    // Patch story title
    const patchStoryRes = await patchStoryRoute(
      new Request(`http://localhost/api/stories/${story.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Nowy Tytuł Zosi' }),
      }),
      { params: Promise.resolve({ id: story.id }) },
    );
    expect(patchStoryRes.status).toBe(200);

    // Upload custom art for slot 1
    const artForm = new FormData();
    artForm.append('file', await makeJpegFile('custom-page1.jpg'));
    const artRes = await uploadIllustrationRoute(
      new Request(`http://localhost/api/stories/${story.id}/illustrations/1`, {
        method: 'POST',
        body: artForm,
      }),
      { params: Promise.resolve({ id: story.id, slot: '1' }) },
    );
    expect(artRes.status).toBe(200);
    const artJson = (await artRes.json()) as { filename: string; assetUrl: string };

    // Read asset back with nosniff
    const assetRes = await getAssetRoute(
      new Request(`http://localhost/api/stories/${story.id}/assets/${artJson.filename}`),
      { params: Promise.resolve({ id: story.id, filename: artJson.filename }) },
    );
    expect(assetRes.status).toBe(200);
    expect(assetRes.headers.get('x-content-type-options')).toBe('nosniff');

    // Reject path traversal asset
    const badAssetRes = await getAssetRoute(
      new Request(`http://localhost/api/stories/${story.id}/assets/../story.json`),
      { params: Promise.resolve({ id: story.id, filename: '../story.json' }) },
    );
    expect(badAssetRes.status).toBe(400);

    // Download binary PDF
    const pdfRes = await getPdfRoute(
      new Request(`http://localhost/api/stories/${story.id}/pdf?format=square`),
      { params: Promise.resolve({ id: story.id }) },
    );
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.headers.get('content-type')).toBe('application/pdf');
    expect(pdfRes.headers.get('content-disposition')).toContain('attachment');
    expect(pdfRes.headers.get('x-content-type-options')).toBe('nosniff');
    const pdfBytes = new Uint8Array(await pdfRes.arrayBuffer());
    expect(Buffer.from(pdfBytes.slice(0, 5)).toString('ascii')).toBe('%PDF-');

    // Run preflight check via API
    const preflightRes = await getPreflightRoute(
      new Request(`http://localhost/api/stories/${story.id}/preflight?format=square`),
      { params: Promise.resolve({ id: story.id }) },
    );
    expect(preflightRes.status).toBe(200);
    const preflightJson = (await preflightRes.json()) as {
      report: { storyId: string; metrics: { totalPdfPages: number } };
    };
    expect(preflightJson.report.storyId).toBe(story.id);
    expect(preflightJson.report.metrics.totalPdfPages).toBe(13);

    // Download print-ready PDF with 3mm bleed, crop marks, and multiple-of-4 padding
    const printPdfRes = await getPdfRoute(
      new Request(
        `http://localhost/api/stories/${story.id}/pdf?format=square&bleedMm=3&cropMarks=true&padToMultipleOf4=true`,
      ),
      { params: Promise.resolve({ id: story.id }) },
    );
    expect(printPdfRes.status).toBe(200);
    expect(printPdfRes.headers.get('content-disposition')).toContain('-print-3mm.pdf');

    // Reject out-of-range bleedMm
    const badBleedRes = await getPdfRoute(
      new Request(`http://localhost/api/stories/${story.id}/pdf?format=square&bleedMm=25`),
      { params: Promise.resolve({ id: story.id }) },
    );
    expect(badBleedRes.status).toBe(400);

    // GDPR/RODO purge of child reference photos (keeps story intact, deletes ref-1.jpg)
    const purgeRes = await purgeReferencePhotosRoute(
      new Request(`http://localhost/api/stories/${story.id}/reference-photos`, {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ id: story.id }) },
    );
    expect(purgeRes.status).toBe(200);
    const purgeJson = (await purgeRes.json()) as {
      purged: boolean;
      deletedFiles: string[];
      purgedAt: string;
    };
    expect(purgeJson.purged).toBe(true);
    expect(purgeJson.deletedFiles).toEqual(['ref-1.jpg']);

    const purgedRefAsset = await getAssetRoute(
      new Request(`http://localhost/api/stories/${story.id}/assets/ref-1.jpg`),
      { params: Promise.resolve({ id: story.id, filename: 'ref-1.jpg' }) },
    );
    expect(purgedRefAsset.status).toBe(404);

    // Delete story
    const delRes = await deleteStoryRoute(
      new Request(`http://localhost/api/stories/${story.id}`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: story.id }) },
    );
    expect(delRes.status).toBe(200);
  });

  it('returns masked settings and updates non-secret defaults via GET/PATCH /api/settings', async () => {
    const res = await getSettings();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      settings: { activeProvider: string };
      providers: Array<{ id: string }>;
      quota: { limit: number };
      storageMode: string;
    };
    expect(body.providers.map((p) => p.id)).toEqual([
      'demo',
      'manual',
      'gemini-api',
      'google-subscription',
    ]);
    expect(body.quota.limit).toBeGreaterThan(0);

    const patchRes = await patchSettings(
      new Request('http://localhost/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeProvider: 'manual', defaultBookFormat: 'a4-landscape' }),
      }),
    );
    expect(patchRes.status).toBe(200);
    const updated = (await patchRes.json()) as {
      settings: { activeProvider: string; defaultBookFormat: string };
    };
    expect(updated.settings.activeProvider).toBe('manual');
    expect(updated.settings.defaultBookFormat).toBe('a4-landscape');
  });
});
