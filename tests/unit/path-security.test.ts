import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getStorageRoot, resetStorageRootCache } from '@/lib/storage/paths';
import {
  DEFAULT_DAILY_IMAGE_LIMIT,
  QuotaExceededError,
  getDailyImageLimit,
  getDailyQuotaStatus,
  releaseDailyQuota,
  reserveDailyQuota,
} from '@/lib/storage/quota';
import {
  PathSecurityError,
  assertValidAssetFilename,
  assertValidStoryId,
  detectImageMime,
  extensionForMime,
  resolveSafeChildPath,
  sanitizeFileSlug,
} from '@/lib/storage/security';
import {
  DEFAULT_RUNTIME_SETTINGS,
  deleteStory,
  generateStoryId,
  getRuntimeSettings,
  getStory,
  listStories,
  readStoryAsset,
  saveRuntimeSettings,
  saveStory,
  saveStoryAsset,
} from '@/lib/storage/store';
import type { StoryRecord } from '@/lib/types/story';

const ENV_KEYS = [
  'BAJKOKREATOR_DATA_DIR',
  'VERCEL',
  'VERCEL_ENV',
  'MAX_DAILY_IMAGE_GENERATIONS',
  'AI_PROVIDER',
  'GEMINI_TEXT_MODEL',
  'GEMINI_IMAGE_MODEL',
  'DEFAULT_PREVIEW_FIRST',
  'DEFAULT_BOOK_FORMAT',
] as const;

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const WEBP_BYTES = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]);

let tmpDir: string;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function makeStoryFixture(id: string, overrides: Partial<StoryRecord> = {}): StoryRecord {
  const now = '2026-11-25T18:00:00.000Z';
  return {
    id,
    createdAt: now,
    updatedAt: now,
    provider: 'demo',
    generationMode: 'full',
    generationStage: 'complete',
    bookFormat: 'square',
    input: {
      childName: 'Zosia',
      childAge: 5,
      gender: 'girl',
      companion: 'kotek Mruczek',
      theme: 'Zażółć gęślą jaźń w leśnym domku',
      artStyle: 'watercolor',
      mood: 'warm-cozy',
      pageCount: 4,
    },
    title: 'Zosia i Zaczarowany Las',
    subtitle: 'Opowieść na dobranoc',
    dedicationText: 'Dla ukochanej Zosi.',
    backCoverBlurb: 'Ciepła opowieść pełna polskich znaków: ą ć ę ł ń ó ś ź ż.',
    characterBible: 'Zosia, 5-year-old girl in warm yellow cardigan.',
    coverPrompt: 'Watercolor storybook cover',
    coverFilename: null,
    demoCoverPath: '/demo-art/cover.jpg',
    coverStatus: 'ready',
    referencePhotos: ['ref-1.jpg'],
    pages: Array.from({ length: 4 }, (_, i) => ({
      pageNumber: i + 1,
      chapterTitle: `Rozdział ${i + 1}`,
      text: `Strona ${i + 1}: Zażółć gęślą jaźń.`,
      imagePrompt: `Scene ${i + 1}`,
      imageFilename: null,
      demoAssetPath: `/demo-art/page-0${i + 1}.jpg`,
      imageStatus: 'ready' as const,
    })),
    modelsUsed: {
      textModel: 'gemini-3.8-flash',
      imageModel: 'gemini-nano-banana-2.1',
    },
    ...overrides,
  };
}

beforeEach(async () => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bajkokreator-storage-test-'));
  process.env.BAJKOKREATOR_DATA_DIR = tmpDir;
  resetStorageRootCache();
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    const val = savedEnv[key];
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
  resetStorageRootCache();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('1. assertValidStoryId', () => {
  it('accepts valid IDs including boundary lengths and generated IDs', () => {
    expect(assertValidStoryId('zosia-1234')).toBe('zosia-1234');
    expect(assertValidStoryId('a_b-09')).toBe('a_b-09');
    expect(assertValidStoryId('abcd')).toBe('abcd');
    expect(assertValidStoryId('a'.repeat(64))).toBe('a'.repeat(64));

    const gen1 = generateStoryId('Zosia');
    const gen2 = generateStoryId('Łukasz & Żaba');
    expect(assertValidStoryId(gen1)).toBe(gen1);
    expect(assertValidStoryId(gen2)).toBe(gen2);
    expect(gen2).toMatch(/^lukasz-zaba-/);
  });

  it('rejects invalid or traversal IDs with PathSecurityError (httpStatus 400)', () => {
    const badIds = [
      '',
      'abc',
      'a'.repeat(65),
      '-abc1',
      '_abc1',
      'Zosia123',
      '../etc',
      'a/b',
      'a\\b',
      'story.json',
      'id\0bad',
      '%2e%2e',
      'id space',
    ];

    for (const id of badIds) {
      let caught: unknown;
      try {
        assertValidStoryId(id);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(PathSecurityError);
      expect((caught as PathSecurityError).httpStatus).toBe(400);
    }
  });
});

describe('2. assertValidAssetFilename', () => {
  it('accepts safe image filenames', () => {
    for (const name of ['ref-1.jpg', 'cover.jpeg', 'page-10.png', 'scene_01.webp', 'Page.1.JPG']) {
      expect(assertValidAssetFilename(name)).toBe(name);
    }
  });

  it('rejects traversal, double-dots, separators, percent-encoding, null bytes, and disallowed extensions', () => {
    const badFilenames = [
      '',
      '../cover.jpg',
      '..\\cover.jpg',
      'sub/cover.jpg',
      'sub\\cover.jpg',
      'a..b.jpg',
      'foo...png',
      '..jpg',
      '.hidden.jpg',
      '%2e%2e%2fcover.jpg',
      'cover.jpg\0.png',
      'image.svg',
      'page.html',
      'book.pdf',
      'noextension',
      `${'a'.repeat(66)}.jpg`,
    ];

    for (const name of badFilenames) {
      expect(() => assertValidAssetFilename(name)).toThrow(PathSecurityError);
    }
  });
});

describe('3. resolveSafeChildPath', () => {
  it('resolves valid nested child paths with or without trailing slash on baseDir', () => {
    const target1 = resolveSafeChildPath(tmpDir, 'stories', 'zosia-1234', 'story.json');
    const target2 = resolveSafeChildPath(`${tmpDir}${path.sep}`, 'stories', 'zosia-1234', 'story.json');
    expect(target1).toBe(path.join(tmpDir, 'stories', 'zosia-1234', 'story.json'));
    expect(target2).toBe(target1);
  });

  it('rejects traversal, backslashes, absolute paths, null bytes, URL-encoding, and empty segments', () => {
    expect(() => resolveSafeChildPath(tmpDir)).toThrow(PathSecurityError);

    const badCases: string[][] = [
      ['.'],
      ['..'],
      ['../outside'],
      ['stories/../../outside'],
      ['..\\..\\etc\\passwd'],
      ['/etc/passwd'],
      ['C:\\Windows\\win.ini'],
      ['stories/id\0'],
      ['%2e%2e'],
      ['%2e%2e%2fsecret'],
      ['%252e'],
      ['%252e%252e'],
      ['%252e%252e%252f'],
      ['%25252e'],
      ['%255c'],
      ['%2500'],
      ['stories/'],
      [''],
    ];

    for (const segments of badCases) {
      expect(() => resolveSafeChildPath(tmpDir, ...segments)).toThrow(PathSecurityError);
    }
  });

  it('blocks sibling prefix collision (/data vs /data-evil)', () => {
    const dataDir = path.join(tmpDir, 'data');
    expect(() => resolveSafeChildPath(dataDir, '..', 'data-evil', 'secret.txt')).toThrow(
      PathSecurityError,
    );
  });

  it('blocks real symlink escapes, dangling symlinks, and cyclic symlink loops on disk', async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bajkokreator-outside-'));
    try {
      const storiesDir = path.join(tmpDir, 'stories');
      await fs.mkdir(storiesDir, { recursive: true });

      // Live symlink pointing outside baseDir
      const escapeLink = path.join(storiesDir, 'escape-link');
      await fs.symlink(outsideDir, escapeLink);

      let escapeErr: unknown;
      try {
        resolveSafeChildPath(tmpDir, 'stories', 'escape-link', 'secret.txt');
      } catch (err) {
        escapeErr = err;
      }
      expect(escapeErr).toBeInstanceOf(PathSecurityError);
      expect((escapeErr as PathSecurityError).code).toBe('SYMLINK_ESCAPE');

      // Dangling symlink pointing outside baseDir
      const danglingLink = path.join(storiesDir, 'dangling');
      await fs.symlink('/nonexistent/outside/path', danglingLink);
      expect(() =>
        resolveSafeChildPath(tmpDir, 'stories', 'dangling', 'file.json'),
      ).toThrow(PathSecurityError);

      // Cyclic symlink loop (ELOOP)
      const loopA = path.join(storiesDir, 'loop-a');
      const loopB = path.join(storiesDir, 'loop-b');
      await fs.symlink(loopB, loopA);
      await fs.symlink(loopA, loopB);
      expect(() => resolveSafeChildPath(tmpDir, 'stories', 'loop-a', 'story.json')).toThrow(
        PathSecurityError,
      );
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });
});

describe('4. detectImageMime & extensionForMime', () => {
  it('detects JPEG, PNG, and WebP from magic bytes and maps extensions', () => {
    expect(detectImageMime(JPEG_BYTES)).toBe('image/jpeg');
    expect(detectImageMime(PNG_BYTES)).toBe('image/png');
    expect(detectImageMime(WEBP_BYTES)).toBe('image/webp');

    expect(extensionForMime('image/jpeg')).toBe('jpg');
    expect(extensionForMime('image/png')).toBe('png');
    expect(extensionForMime('image/webp')).toBe('webp');
  });

  it('returns null for truncated, non-image, SVG, HTML, PDF, GIF, and WAVE buffers', () => {
    const invalidBuffers = [
      Buffer.alloc(0),
      Buffer.from([0xff, 0xd8]),
      Buffer.from('RIFF\x24\x00\x00\x00WEB', 'ascii'), // short WebP (<12 bytes)
      Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'ascii'), // RIFF/WAVE
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8'),
      Buffer.from('<!DOCTYPE html><html></html>', 'utf8'),
      Buffer.from('%PDF-1.7\n', 'utf8'),
      Buffer.from('GIF89a\x01\x00\x01\x00', 'ascii'),
      Buffer.from('plain text file', 'utf8'),
    ];

    for (const buf of invalidBuffers) {
      expect(detectImageMime(buf)).toBeNull();
    }
  });
});

describe('5. sanitizeFileSlug', () => {
  it('transliterates all Polish diacritics including ł/Ł properly', () => {
    expect(sanitizeFileSlug('Zażółć gęślą jaźń!')).toBe('zazolc-gesla-jazn');
    expect(sanitizeFileSlug('ĄĆĘŁŃÓŚŹŻ')).toBe('acelnoszz');
    expect(sanitizeFileSlug('../../../etc/passwd')).toBe('etc-passwd');
    expect(sanitizeFileSlug('!!!   🌟')).toBe('bajka');
    expect(sanitizeFileSlug('!!!   🌟', 'okladka')).toBe('okladka');
    expect(sanitizeFileSlug('bardzo-dlugi-tytul-bajki-dla-dzieci', 'bajka', 13)).toBe(
      'bardzo-dlugi',
    );
  });
});

describe('6. getStorageRoot (local, env, Vercel, and read-only fallback)', () => {
  it('uses BAJKOKREATOR_DATA_DIR and reacts cleanly when env var changes', async () => {
    const first = await getStorageRoot();
    expect(first).toEqual({ rootDir: path.resolve(tmpDir), mode: 'local' });

    const altDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bajkokreator-alt-'));
    try {
      process.env.BAJKOKREATOR_DATA_DIR = altDir;
      const second = await getStorageRoot();
      expect(second).toEqual({ rootDir: path.resolve(altDir), mode: 'local' });
    } finally {
      await fs.rm(altDir, { recursive: true, force: true });
    }
  });

  it('uses /tmp/bajkokreator-data fallback when VERCEL=1 or VERCEL_ENV is set', async () => {
    delete process.env.BAJKOKREATOR_DATA_DIR;
    process.env.VERCEL = '1';
    const expectedTmp = path.join(os.tmpdir(), 'bajkokreator-data');

    const vercelOne = await getStorageRoot();
    expect(vercelOne).toEqual({ rootDir: expectedTmp, mode: 'tmp-fallback' });

    delete process.env.VERCEL;
    process.env.VERCEL_ENV = 'production';
    const vercelEnv = await getStorageRoot();
    expect(vercelEnv).toEqual({ rootDir: expectedTmp, mode: 'tmp-fallback' });
  });

  it('probes writable <cwd>/data without leaving stray probe files and falls back on read-only <cwd>', async () => {
    delete process.env.BAJKOKREATOR_DATA_DIR;
    const writableCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'bajkokreator-cwd-ok-'));
    const roCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'bajkokreator-cwd-ro-'));

    try {
      vi.spyOn(process, 'cwd').mockReturnValue(writableCwd);
      const localRes = await getStorageRoot();
      expect(localRes).toEqual({
        rootDir: path.join(writableCwd, 'data'),
        mode: 'local',
      });
      const filesInData = await fs.readdir(localRes.rootDir);
      expect(filesInData.filter((f) => f.startsWith('.write-probe-'))).toEqual([]);

      await fs.chmod(roCwd, 0o555);
      vi.spyOn(process, 'cwd').mockReturnValue(roCwd);
      resetStorageRootCache();

      if (process.getuid?.() === 0) {
        const eacces = Object.assign(new Error('EACCES'), { code: 'EACCES' });
        vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(eacces);
      }

      const fallbackRes = await getStorageRoot();
      expect(fallbackRes).toEqual({
        rootDir: path.join(os.tmpdir(), 'bajkokreator-data'),
        mode: 'tmp-fallback',
      });
    } finally {
      await fs.chmod(roCwd, 0o755).catch(() => {});
      await fs.rm(writableCwd, { recursive: true, force: true });
      await fs.rm(roCwd, { recursive: true, force: true });
    }
  });

  it('detects read-only (0o555) transition on a cached local root without cache reset and falls back cleanly', async () => {
    const transDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bajkokreator-ro-trans-'));
    try {
      process.env.BAJKOKREATOR_DATA_DIR = transDir;
      resetStorageRootCache();

      const before = await getStorageRoot();
      expect(before).toEqual({ rootDir: path.resolve(transDir), mode: 'local' });

      await fs.chmod(transDir, 0o555);
      if (process.getuid?.() === 0) {
        const eacces = Object.assign(new Error('EACCES'), { code: 'EACCES' });
        vi.spyOn(fs, 'access').mockRejectedValueOnce(eacces);
        vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(eacces);
      }

      // Do NOT call resetStorageRootCache(): cache hit must detect W_OK failure
      const after = await getStorageRoot();
      expect(after).toEqual({
        rootDir: path.join(os.tmpdir(), 'bajkokreator-data'),
        mode: 'tmp-fallback',
      });

      const story = makeStoryFixture('ro-fallback-story-01');
      await saveStory(story);
      expect(await getStory(story.id)).toEqual(story);
      await deleteStory(story.id);
    } finally {
      await fs.chmod(transDir, 0o755).catch(() => {});
      await fs.rm(transDir, { recursive: true, force: true });
    }
  });
});

describe('7. Story CRUD, Assets & Runtime Settings (store.ts)', () => {
  it('saves and loads stories atomically, preserving Polish text without leftover .tmp files', async () => {
    const story = makeStoryFixture('zosia-test-01');
    await saveStory(story);

    const loaded = await getStory('zosia-test-01');
    expect(loaded).toEqual(story);

    const storyDir = path.join(tmpDir, 'stories', 'zosia-test-01');
    const files = await fs.readdir(storyDir);
    expect(files).toEqual(['story.json']);

    expect(await getStory('nonexistent-story-id')).toBeNull();
    await expect(getStory('../evil')).rejects.toThrow(PathSecurityError);
  });

  it('lists stories sorted newest first, maps coverUrl accurately, and skips corrupt folders', async () => {
    const older = makeStoryFixture('story-older-01', {
      createdAt: '2026-11-24T10:00:00.000Z',
      updatedAt: '2026-11-24T10:00:00.000Z',
      coverFilename: null,
      demoCoverPath: '/demo-art/cover.jpg',
    });
    const newer = makeStoryFixture('story-newer-02', {
      createdAt: '2026-11-25T10:00:00.000Z',
      updatedAt: '2026-11-25T12:00:00.000Z',
      coverFilename: 'cover.jpg',
      demoCoverPath: null,
    });

    await saveStory(older);
    await saveStory(newer);

    // Seed corrupt JSON, structurally partial JSON, tampered demoCoverPath, and stray non-ID directory
    await fs.mkdir(path.join(tmpDir, 'stories', 'corrupt-story-03'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'stories', 'corrupt-story-03', 'story.json'),
      '{not-valid-json',
      'utf8',
    );
    await fs.mkdir(path.join(tmpDir, 'stories', 'partial-json-01'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'stories', 'partial-json-01', 'story.json'),
      JSON.stringify({ id: 'partial-json-01', input: {}, pages: [] }),
      'utf8',
    );
    await fs.mkdir(path.join(tmpDir, 'stories', 'tampered-cover-01'), { recursive: true });
    const tampered = {
      ...makeStoryFixture('tampered-cover-01'),
      demoCoverPath: 'javascript:alert(1)',
    };
    await fs.writeFile(
      path.join(tmpDir, 'stories', 'tampered-cover-01', 'story.json'),
      JSON.stringify(tampered),
      'utf8',
    );
    await fs.mkdir(path.join(tmpDir, 'stories', 'INVALID_DIR_NAME'), { recursive: true });

    expect(await getStory('partial-json-01')).toBeNull();
    expect(await getStory('tampered-cover-01')).toBeNull();
    await expect(saveStory(tampered)).rejects.toThrow();

    const list = await listStories();
    expect(list.map((s) => s.id)).toEqual(['story-newer-02', 'story-older-01']);
    expect(list[0].coverUrl).toBe('/api/stories/story-newer-02/assets/cover.jpg');
    expect(list[1].coverUrl).toBe('/demo-art/cover.jpg');
    expect(list[0].pageCount).toBe(4);
  });

  it('deletes stories cleanly and rejects invalid delete IDs', async () => {
    const story = makeStoryFixture('story-delete-01');
    await saveStory(story);
    await saveStoryAsset(story.id, 'cover.jpg', JPEG_BYTES);

    expect(await deleteStory(story.id)).toBe(true);
    expect(await deleteStory(story.id)).toBe(false);
    expect(await getStory(story.id)).toBeNull();
    await expect(deleteStory('../outside')).rejects.toThrow(PathSecurityError);
  });

  it('round-trips JPEG, PNG, and WebP assets and rejects invalid/malicious assets', async () => {
    const storyId = 'story-assets-01';
    expect(await saveStoryAsset(storyId, 'ref-1.jpg', JPEG_BYTES)).toBe('ref-1.jpg');
    expect(await saveStoryAsset(storyId, 'page-1.png', PNG_BYTES)).toBe('page-1.png');
    expect(await saveStoryAsset(storyId, 'cover.webp', WEBP_BYTES)).toBe('cover.webp');

    const jpg = await readStoryAsset(storyId, 'ref-1.jpg');
    expect(jpg?.mimeType).toBe('image/jpeg');
    expect(jpg?.buffer.equals(JPEG_BYTES)).toBe(true);

    const png = await readStoryAsset(storyId, 'page-1.png');
    expect(png?.mimeType).toBe('image/png');
    expect(png?.buffer.equals(PNG_BYTES)).toBe(true);

    const webp = await readStoryAsset(storyId, 'cover.webp');
    expect(webp?.mimeType).toBe('image/webp');
    expect(webp?.buffer.equals(WEBP_BYTES)).toBe(true);

    expect(await readStoryAsset(storyId, 'missing.jpg')).toBeNull();

    await expect(saveStoryAsset(storyId, 'empty.jpg', Buffer.alloc(0))).rejects.toThrow(
      PathSecurityError,
    );
    await expect(
      saveStoryAsset(storyId, 'bad.jpg', Buffer.from('<svg></svg>', 'utf8')),
    ).rejects.toThrow(PathSecurityError);
    await expect(saveStoryAsset('../evil', 'cover.jpg', JPEG_BYTES)).rejects.toThrow(
      PathSecurityError,
    );
    await expect(saveStoryAsset(storyId, '../cover.jpg', JPEG_BYTES)).rejects.toThrow(
      PathSecurityError,
    );
  });

  it('reads defaults + env overrides and persists partial runtime settings cleanly', async () => {
    expect(await getRuntimeSettings()).toEqual(DEFAULT_RUNTIME_SETTINGS);

    process.env.AI_PROVIDER = 'manual';
    process.env.GEMINI_TEXT_MODEL = 'gemini-3.8-flash';
    process.env.GEMINI_IMAGE_MODEL = 'gemini-3-pro-image';
    expect(await getRuntimeSettings()).toEqual({
      ...DEFAULT_RUNTIME_SETTINGS,
      activeProvider: 'manual',
      imageModel: 'gemini-3-pro-image',
    });

    const updated = await saveRuntimeSettings({
      activeProvider: 'gemini-api',
      defaultPreviewFirst: true,
      defaultBookFormat: 'a4-landscape',
    });
    expect(updated).toEqual({
      activeProvider: 'gemini-api',
      textModel: 'gemini-3.8-flash',
      imageModel: 'gemini-3-pro-image',
      defaultPreviewFirst: true,
      defaultBookFormat: 'a4-landscape',
    });

    // Persisted settings survive reload
    expect(await getRuntimeSettings()).toEqual(updated);
  });
});

describe('8. Daily Quota (quota.ts)', () => {
  it('parses MAX_DAILY_IMAGE_GENERATIONS with safe defaults', () => {
    expect(getDailyImageLimit()).toBe(DEFAULT_DAILY_IMAGE_LIMIT);

    process.env.MAX_DAILY_IMAGE_GENERATIONS = '15';
    expect(getDailyImageLimit()).toBe(15);

    process.env.MAX_DAILY_IMAGE_GENERATIONS = '0';
    expect(getDailyImageLimit()).toBe(0);

    for (const invalid of ['-1', 'abc', '3.5', '12px', '']) {
      process.env.MAX_DAILY_IMAGE_GENERATIONS = invalid;
      expect(getDailyImageLimit()).toBe(DEFAULT_DAILY_IMAGE_LIMIT);
    }
  });

  it('reserves, enforces HTTP 429 QuotaExceededError, and releases without going negative', async () => {
    process.env.MAX_DAILY_IMAGE_GENERATIONS = '10';

    const initial = await getDailyQuotaStatus();
    expect(initial.used).toBe(0);
    expect(initial.limit).toBe(10);
    expect(initial.remaining).toBe(10);

    const after6 = await reserveDailyQuota(6);
    expect(after6.used).toBe(6);
    expect(after6.remaining).toBe(4);

    let caught: unknown;
    try {
      await reserveDailyQuota(5);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(QuotaExceededError);
    expect((caught as QuotaExceededError).httpStatus).toBe(429);

    // Failed reservation must not mutate persisted count
    expect((await getDailyQuotaStatus()).used).toBe(6);

    await releaseDailyQuota(2);
    expect((await getDailyQuotaStatus()).used).toBe(4);

    // Clamp cleanly at 0
    await releaseDailyQuota(99);
    expect((await getDailyQuotaStatus()).used).toBe(0);

    for (const bad of [-1, 1.5, Number.NaN]) {
      await expect(reserveDailyQuota(bad)).rejects.toThrow(RangeError);
      await expect(releaseDailyQuota(bad)).rejects.toThrow(RangeError);
    }
  });

  it('prevents concurrent overbooking via in-process mutex', async () => {
    process.env.MAX_DAILY_IMAGE_GENERATIONS = '5';

    const results = await Promise.allSettled([reserveDailyQuota(3), reserveDailyQuota(3)]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (rejected[0].status === 'rejected') {
      expect(rejected[0].reason).toBeInstanceOf(QuotaExceededError);
    }
    expect((await getDailyQuotaStatus()).used).toBe(3);
  });

  it('rolls over automatically when persisted date is from a previous UTC day', async () => {
    const quotaFile = path.join(tmpDir, 'quota', 'daily-usage.json');
    await fs.mkdir(path.dirname(quotaFile), { recursive: true });
    await fs.writeFile(
      quotaFile,
      JSON.stringify({
        date: '2020-01-01',
        used: 30,
        updatedAt: '2020-01-01T12:00:00.000Z',
      }),
      'utf8',
    );

    const status = await getDailyQuotaStatus();
    expect(status.used).toBe(0);
    expect(status.remaining).toBe(30);
    expect(status.date).toBe(new Date().toISOString().slice(0, 10));
  });

  it('resets corrupted non-safe huge integer usage (e.g. 1e30) cleanly to 0 and rejects non-safe counts', async () => {
    process.env.MAX_DAILY_IMAGE_GENERATIONS = '5';
    const today = new Date().toISOString().slice(0, 10);
    const quotaFile = path.join(tmpDir, 'quota', 'daily-usage.json');
    await fs.mkdir(path.dirname(quotaFile), { recursive: true });
    await fs.writeFile(
      quotaFile,
      JSON.stringify({
        date: today,
        used: 1e30,
        updatedAt: `${today}T12:00:00.000Z`,
      }),
      'utf8',
    );

    const status = await getDailyQuotaStatus();
    expect(status).toEqual({
      date: today,
      used: 0,
      limit: 5,
      remaining: 5,
    });

    await expect(reserveDailyQuota(1e30)).rejects.toThrow(RangeError);
    await expect(releaseDailyQuota(1e30)).rejects.toThrow(RangeError);
  });
});
