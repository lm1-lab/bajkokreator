import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPolishStoryDraft } from '@/lib/polish/templates';
import { resetStorageRootCache } from '@/lib/storage/paths';
import {
  getStorageInfo,
  getStory,
  getStoryRepository,
  purgeStoryReferencePhotos,
  readStoryAsset,
  resetStoryRepository,
  saveStory,
  saveStoryAsset,
  setStoryRepository,
  updateStory,
  type StoryRepository,
} from '@/lib/storage/store';
import type { StoryInput, StoryRecord } from '@/lib/types/story';

const originalDataDir = process.env.BAJKOKREATOR_DATA_DIR;
let tempDir = '';

afterEach(async () => {
  resetStoryRepository();
  if (originalDataDir === undefined) {
    delete process.env.BAJKOKREATOR_DATA_DIR;
  } else {
    process.env.BAJKOKREATOR_DATA_DIR = originalDataDir;
  }
  resetStorageRootCache();
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = '';
  }
});

function makeRecord(id: string): StoryRecord {
  const input: StoryInput = {
    childName: 'Antoś',
    childAge: 6,
    gender: 'boy',
    theme: 'Kosmiczna podróż w poszukiwaniu srebrnej komety',
    artStyle: 'watercolor',
    mood: 'magical-adventure',
    pageCount: 4,
  };
  const draft = buildPolishStoryDraft(input);
  const now = new Date().toISOString();
  return {
    id,
    createdAt: now,
    updatedAt: now,
    provider: 'demo',
    generationMode: 'full',
    generationStage: 'complete',
    bookFormat: 'square',
    input,
    title: draft.title,
    subtitle: draft.subtitle,
    dedicationText: draft.dedicationText,
    backCoverBlurb: draft.backCoverBlurb,
    characterBible: draft.characterBible,
    coverPrompt: draft.coverPrompt,
    coverFilename: null,
    demoCoverPath: '/demo-art/cover.jpg',
    coverStatus: 'ready',
    referencePhotos: ['ref-1.jpg', 'ref-2.jpg'],
    pages: draft.pages.map((p) => ({
      ...p,
      imageFilename: null,
      demoAssetPath: `/demo-art/page-${String(p.pageNumber).padStart(2, '0')}.jpg`,
      imageStatus: 'ready',
    })),
    modelsUsed: {
      textModel: 'demo-polish-storyteller-v1',
      imageModel: 'demo-watercolor-plates-v1',
    },
  };
}

describe('StoryRepository abstraction, mutex & GDPR photo purge', () => {
  it('allows swapping in a custom vendor-agnostic repository adapter with getStorageInfo()', async () => {
    const mockRepo: StoryRepository = {
      kind: 'mock-memory',
      storageMode: 'custom',
      async getStorageInfo() {
        return { mode: 'custom', writable: true, location: 'memory://mock' };
      },
      async saveStory() {},
      async getStory() {
        return null;
      },
      async listStories() {
        return [];
      },
      async deleteStory() {
        return false;
      },
      async saveAsset(_id, filename) {
        return filename;
      },
      async readAsset() {
        return null;
      },
      async deleteAsset() {
        return false;
      },
      async purgeReferencePhotos() {
        return null;
      },
      async getRuntimeSettings() {
        return {
          activeProvider: 'demo',
          textModel: 'gemini-3.8-flash',
          imageModel: 'gemini-nano-banana-2.1',
          defaultPreviewFirst: false,
          defaultBookFormat: 'square',
          geminiImageSize: '1K',
        };
      },
      async saveRuntimeSettings() {
        return {
          activeProvider: 'demo',
          textModel: 'gemini-3.8-flash',
          imageModel: 'gemini-nano-banana-2.1',
          defaultPreviewFirst: false,
          defaultBookFormat: 'square',
          geminiImageSize: '1K',
        };
      },
    };

    expect(getStoryRepository().kind).toBe('filesystem');
    setStoryRepository(mockRepo);
    expect(getStoryRepository().kind).toBe('mock-memory');
    expect(await getStorageInfo()).toEqual({
      mode: 'custom',
      writable: true,
      location: 'memory://mock',
    });
    expect(await getStory('antos-test-01')).toBeNull();
    resetStoryRepository();
    expect(getStoryRepository().kind).toBe('filesystem');
  });

  it('reports writable local storage via getStorageInfo()', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bajkokreator-repo-info-'));
    process.env.BAJKOKREATOR_DATA_DIR = tempDir;
    resetStorageRootCache();

    const info = await getStorageInfo();
    expect(info.mode).toBe('local');
    expect(info.writable).toBe(true);
    expect(info.location).toBe(path.resolve(tempDir));
  });

  it('purges reference photos idempotently (preserving original timestamp) and sweeps orphaned ref-* files', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bajkokreator-repo-test-'));
    process.env.BAJKOKREATOR_DATA_DIR = tempDir;
    resetStorageRootCache();

    const jpegBuf = await sharp({
      create: { width: 80, height: 80, channels: 3, background: { r: 200, g: 160, b: 120 } },
    })
      .jpeg()
      .toBuffer();

    const story = makeRecord('antos-gdpr-01');
    await saveStory(story);
    await saveStoryAsset(story.id, 'ref-1.jpg', jpegBuf);
    await saveStoryAsset(story.id, 'ref-2.jpg', jpegBuf);
    await saveStoryAsset(story.id, 'ref-9.jpg', jpegBuf); // orphaned ref file not in story.referencePhotos
    await saveStoryAsset(story.id, 'page-1.jpg', jpegBuf);

    const first = await purgeStoryReferencePhotos(story.id);
    expect(first).not.toBeNull();
    expect(first?.alreadyPurged).toBe(false);
    expect(first?.deletedFiles).toEqual(['ref-1.jpg', 'ref-2.jpg', 'ref-9.jpg']);

    // Reference photos (including orphan) are deleted
    expect(await readStoryAsset(story.id, 'ref-1.jpg')).toBeNull();
    expect(await readStoryAsset(story.id, 'ref-2.jpg')).toBeNull();
    expect(await readStoryAsset(story.id, 'ref-9.jpg')).toBeNull();

    // Non-reference illustrations and story record remain intact
    expect(await readStoryAsset(story.id, 'page-1.jpg')).not.toBeNull();
    const afterFirst = await getStory(story.id);
    expect(afterFirst?.referencePhotos).toEqual([]);
    expect(afterFirst?.referencePhotosPurgedAt).toBe(first?.purgedAt);

    // Wait briefly and call purge again -> strictly idempotent, preserves exact timestamps
    await new Promise((resolve) => setTimeout(resolve, 15));
    const second = await purgeStoryReferencePhotos(story.id);
    expect(second).toEqual({
      storyId: story.id,
      deletedFiles: [],
      purgedAt: first?.purgedAt,
      alreadyPurged: true,
    });

    const afterSecond = await getStory(story.id);
    expect(afterSecond?.referencePhotosPurgedAt).toBe(afterFirst?.referencePhotosPurgedAt);
    expect(afterSecond?.updatedAt).toBe(afterFirst?.updatedAt);
  });

  it('serializes concurrent updateStory() writes via per-story mutex without losing updates or deadlocking', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bajkokreator-mutex-test-'));
    process.env.BAJKOKREATOR_DATA_DIR = tempDir;
    resetStorageRootCache();

    const story = makeRecord('antos-mutex-01');
    await saveStory(story);

    // Fire 4 concurrent read-modify-write updates targeting different pages of the same story
    await Promise.all([
      updateStory(story.id, async (current) => {
        await new Promise((r) => setTimeout(r, 15));
        const pages = current.pages.map((p) =>
          p.pageNumber === 1 ? { ...p, text: 'Zaktualizowana strona 1' } : p,
        );
        return { ...current, pages };
      }),
      updateStory(story.id, async (current) => {
        await new Promise((r) => setTimeout(r, 5));
        const pages = current.pages.map((p) =>
          p.pageNumber === 2 ? { ...p, text: 'Zaktualizowana strona 2' } : p,
        );
        return { ...current, pages };
      }),
      updateStory(story.id, async (current) => {
        const pages = current.pages.map((p) =>
          p.pageNumber === 3 ? { ...p, text: 'Zaktualizowana strona 3' } : p,
        );
        return { ...current, pages };
      }),
      updateStory(story.id, async (current) => {
        const pages = current.pages.map((p) =>
          p.pageNumber === 4 ? { ...p, text: 'Zaktualizowana strona 4' } : p,
        );
        return { ...current, pages };
      }),
    ]);

    const finalStory = await getStory(story.id);
    expect(finalStory?.pages[0].text).toBe('Zaktualizowana strona 1');
    expect(finalStory?.pages[1].text).toBe('Zaktualizowana strona 2');
    expect(finalStory?.pages[2].text).toBe('Zaktualizowana strona 3');
    expect(finalStory?.pages[3].text).toBe('Zaktualizowana strona 4');

    // Ensure no leftover .tmp files in story directory
    const files = await fs.readdir(path.join(tempDir, 'stories', story.id));
    expect(files.some((f) => f.includes('.tmp.'))).toBe(false);
  });
});
