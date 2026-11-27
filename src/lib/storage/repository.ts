import { constants as fsConstants, type Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import {
  BookFormatSchema,
  DEFAULT_GEMINI_IMAGE_SIZE,
  DEFAULT_RUNTIME_SETTINGS,
  DEMO_ASSET_PATH_REGEX,
  GeminiImageSizeSchema,
  ModelIdSchema,
  ProviderIdSchema,
  RuntimeSettingsSchema,
  StoryRecordSchema,
  type RuntimeSettings,
  type StorageMode,
  type StoryRecord,
  type StorySummary,
} from '@/lib/types/story';
import { getStorageRoot, writeFileAtomic } from './paths';
import {
  ASSET_FILENAME_REGEX,
  PathSecurityError,
  STORY_ID_REGEX,
  assertValidAssetFilename,
  assertValidStoryId,
  detectImageMime,
  resolveSafeChildPath,
  type AllowedImageMime,
} from './security';

export const MAX_ASSET_BYTES = 10 * 1024 * 1024; // 10 MB

export interface StorageInfo {
  mode: StorageMode;
  writable: boolean;
  location: string;
}

export interface StoryAssetRecord {
  buffer: Buffer;
  mimeType: AllowedImageMime;
}

export interface PurgeReferencePhotosResult {
  storyId: string;
  deletedFiles: string[];
  purgedAt: string;
  alreadyPurged: boolean;
}

/**
 * Vendor-agnostic persistence port for stories, binary assets, runtime settings,
 * and GDPR/RODO reference photo retention purges.
 *
 * Swap in a Postgres + S3/R2 adapter via `setStoryRepository()` without modifying
 * any API routes or domain logic.
 */
export interface StoryRepository {
  readonly kind: string;
  readonly storageMode: StorageMode;
  getStorageInfo(): Promise<StorageInfo>;
  saveStory(story: StoryRecord): Promise<void>;
  updateStory?(
    id: string,
    updater: (story: StoryRecord) => Promise<StoryRecord | null> | StoryRecord | null,
  ): Promise<StoryRecord | null>;
  getStory(id: string): Promise<StoryRecord | null>;
  listStories(): Promise<StorySummary[]>;
  deleteStory(id: string): Promise<boolean>;
  saveAsset(id: string, filename: string, buffer: Buffer): Promise<string>;
  readAsset(id: string, filename: string): Promise<StoryAssetRecord | null>;
  deleteAsset(id: string, filename: string): Promise<boolean>;
  purgeReferencePhotos(id: string): Promise<PurgeReferencePhotosResult | null>;
  getRuntimeSettings(): Promise<RuntimeSettings>;
  saveRuntimeSettings(patch: Partial<RuntimeSettings>): Promise<RuntimeSettings>;
}

const PartialRuntimeSettingsSchema = RuntimeSettingsSchema.partial();

function getErrnoCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function parseTimestampMs(iso: string | undefined): number {
  if (!iso) return 0;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function mapStoryToSummary(story: StoryRecord): StorySummary {
  const safeCoverFilename =
    story.coverFilename &&
    ASSET_FILENAME_REGEX.test(story.coverFilename) &&
    !story.coverFilename.includes('..')
      ? story.coverFilename
      : null;
  const safeDemoCoverPath =
    typeof story.demoCoverPath === 'string' && DEMO_ASSET_PATH_REGEX.test(story.demoCoverPath)
      ? story.demoCoverPath
      : null;
  const coverUrl = safeCoverFilename
    ? `/api/stories/${story.id}/assets/${safeCoverFilename}`
    : safeDemoCoverPath;

  return {
    id: story.id,
    title: story.title,
    subtitle: story.subtitle,
    childName: story.input.childName,
    childAge: story.input.childAge,
    gender: story.input.gender,
    provider: story.provider,
    generationStage: story.generationStage,
    bookFormat: story.bookFormat,
    pageCount: story.pages.length,
    coverUrl,
    referencePhotosCount: story.referencePhotos.length,
    ...(story.referencePhotosPurgedAt
      ? { referencePhotosPurgedAt: story.referencePhotosPurgedAt }
      : {}),
    createdAt: story.createdAt,
    updatedAt: story.updatedAt,
  };
}

export function getEnvRuntimeDefaults(): RuntimeSettings {
  const settings: RuntimeSettings = { ...DEFAULT_RUNTIME_SETTINGS };

  const rawProvider = process.env.AI_PROVIDER?.trim();
  if (rawProvider) {
    const parsed = ProviderIdSchema.safeParse(rawProvider);
    if (parsed.success) {
      settings.activeProvider = parsed.data;
    }
  }

  const rawTextModel = process.env.GEMINI_TEXT_MODEL?.trim();
  if (rawTextModel) {
    const parsed = ModelIdSchema.safeParse(rawTextModel);
    if (parsed.success) {
      settings.textModel = parsed.data;
    }
  }

  const rawImageModel = process.env.GEMINI_IMAGE_MODEL?.trim();
  if (rawImageModel) {
    const parsed = ModelIdSchema.safeParse(rawImageModel);
    if (parsed.success) {
      settings.imageModel = parsed.data;
    }
  }

  const rawImageSize = process.env.GEMINI_IMAGE_SIZE?.trim();
  if (rawImageSize) {
    const parsed = GeminiImageSizeSchema.safeParse(rawImageSize);
    if (parsed.success) {
      settings.geminiImageSize = parsed.data;
    }
  }

  const rawPreview = process.env.DEFAULT_PREVIEW_FIRST?.trim().toLowerCase();
  if (rawPreview === 'true' || rawPreview === '1') {
    settings.defaultPreviewFirst = true;
  } else if (rawPreview === 'false' || rawPreview === '0') {
    settings.defaultPreviewFirst = false;
  }

  const rawFormat = process.env.DEFAULT_BOOK_FORMAT?.trim();
  if (rawFormat) {
    const parsed = BookFormatSchema.safeParse(rawFormat);
    if (parsed.success) {
      settings.defaultBookFormat = parsed.data;
    }
  }

  return settings;
}

export class FilesystemStoryRepository implements StoryRepository {
  readonly kind = 'filesystem';
  private lastStorageMode: StorageMode = 'local';
  private readonly storyLocks = new Map<string, Promise<void>>();
  private settingsLock: Promise<void> = Promise.resolve();

  get storageMode(): StorageMode {
    return this.lastStorageMode;
  }

  private async withStoryLock<T>(storyId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.storyLocks.get(storyId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(
      () => current,
      () => current,
    );
    this.storyLocks.set(storyId, tail);

    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.storyLocks.get(storyId) === tail) {
        this.storyLocks.delete(storyId);
      }
    }
  }

  private async withSettingsLock<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.settingsLock;
    let release!: () => void;
    this.settingsLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
    }
  }

  async getStorageInfo(): Promise<StorageInfo> {
    const { rootDir, mode } = await getStorageRoot();
    this.lastStorageMode = mode;
    const writable = await fs
      .access(rootDir, fsConstants.W_OK)
      .then(() => true)
      .catch(() => false);
    return {
      mode,
      writable,
      location: rootDir,
    };
  }

  private async getStoryUnlocked(safeId: string): Promise<StoryRecord | null> {
    const { rootDir, mode } = await getStorageRoot();
    this.lastStorageMode = mode;
    const storyPath = resolveSafeChildPath(rootDir, 'stories', safeId, 'story.json');

    let raw: string;
    try {
      raw = await fs.readFile(storyPath, 'utf8');
    } catch (err) {
      if (getErrnoCode(err) === 'ENOENT') {
        return null;
      }
      throw err;
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      const validated = StoryRecordSchema.safeParse(parsed);
      if (!validated.success || validated.data.id !== safeId) {
        return null;
      }
      return validated.data;
    } catch {
      return null;
    }
  }

  private async saveStoryUnlocked(safeId: string, story: StoryRecord): Promise<StoryRecord> {
    const validated = StoryRecordSchema.parse(story);
    const { rootDir, mode } = await getStorageRoot();
    this.lastStorageMode = mode;
    const storyPath = resolveSafeChildPath(rootDir, 'stories', safeId, 'story.json');
    await writeFileAtomic(storyPath, `${JSON.stringify(validated, null, 2)}\n`);
    return validated;
  }

  private async deleteStoryUnlocked(safeId: string): Promise<boolean> {
    const { rootDir, mode } = await getStorageRoot();
    this.lastStorageMode = mode;
    const storyDir = resolveSafeChildPath(rootDir, 'stories', safeId);

    try {
      await fs.lstat(storyDir);
    } catch (err) {
      if (getErrnoCode(err) === 'ENOENT') {
        return false;
      }
      throw err;
    }

    await fs.rm(storyDir, { recursive: true, force: true });
    return true;
  }

  private async saveAssetUnlocked(
    safeId: string,
    safeFilename: string,
    buffer: Buffer,
  ): Promise<string> {
    const { rootDir, mode } = await getStorageRoot();
    this.lastStorageMode = mode;
    const assetPath = resolveSafeChildPath(rootDir, 'stories', safeId, 'assets', safeFilename);
    await writeFileAtomic(assetPath, buffer);
    return safeFilename;
  }

  private async deleteAssetUnlocked(safeId: string, safeFilename: string): Promise<boolean> {
    const { rootDir, mode } = await getStorageRoot();
    this.lastStorageMode = mode;
    const assetPath = resolveSafeChildPath(rootDir, 'stories', safeId, 'assets', safeFilename);

    try {
      await fs.unlink(assetPath);
      return true;
    } catch (err) {
      if (getErrnoCode(err) === 'ENOENT') {
        return false;
      }
      throw err;
    }
  }

  async saveStory(story: StoryRecord): Promise<void> {
    const safeId = assertValidStoryId(story.id);
    await this.withStoryLock(safeId, async () => {
      await this.saveStoryUnlocked(safeId, story);
    });
  }

  async updateStory(
    id: string,
    updater: (story: StoryRecord) => Promise<StoryRecord | null> | StoryRecord | null,
  ): Promise<StoryRecord | null> {
    const safeId = assertValidStoryId(id);
    return this.withStoryLock(safeId, async () => {
      const existing = await this.getStoryUnlocked(safeId);
      if (!existing) {
        return null;
      }
      const next = await updater(existing);
      if (!next) {
        return null;
      }
      return this.saveStoryUnlocked(safeId, next);
    });
  }

  async getStory(id: string): Promise<StoryRecord | null> {
    const safeId = assertValidStoryId(id);
    return this.getStoryUnlocked(safeId);
  }

  async listStories(): Promise<StorySummary[]> {
    const { rootDir, mode } = await getStorageRoot();
    this.lastStorageMode = mode;
    const storiesDir = resolveSafeChildPath(rootDir, 'stories');

    let entries: Dirent[];
    try {
      entries = await fs.readdir(storiesDir, { withFileTypes: true });
    } catch (err) {
      if (getErrnoCode(err) === 'ENOENT') {
        return [];
      }
      throw err;
    }

    const summaries: StorySummary[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (!STORY_ID_REGEX.test(entry.name)) {
        continue;
      }

      try {
        const story = await this.getStoryUnlocked(entry.name);
        if (story) {
          summaries.push(mapStoryToSummary(story));
        }
      } catch {
        // Skip unreadable or corrupted entries without breaking the library listing
        continue;
      }
    }

    summaries.sort((a, b) => {
      const updatedDiff =
        parseTimestampMs(b.updatedAt || b.createdAt) -
        parseTimestampMs(a.updatedAt || a.createdAt);
      if (updatedDiff !== 0) return updatedDiff;

      const createdDiff = parseTimestampMs(b.createdAt) - parseTimestampMs(a.createdAt);
      if (createdDiff !== 0) return createdDiff;

      return b.id.localeCompare(a.id);
    });

    return summaries;
  }

  async deleteStory(id: string): Promise<boolean> {
    const safeId = assertValidStoryId(id);
    return this.withStoryLock(safeId, () => this.deleteStoryUnlocked(safeId));
  }

  async saveAsset(id: string, filename: string, buffer: Buffer): Promise<string> {
    const safeId = assertValidStoryId(id);
    const safeFilename = assertValidAssetFilename(filename);

    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new PathSecurityError('Image buffer must not be empty', 'EMPTY_ASSET');
    }
    if (buffer.length > MAX_ASSET_BYTES) {
      throw new PathSecurityError(
        'Image exceeds maximum allowed size (10 MB)',
        'ASSET_TOO_LARGE',
      );
    }

    const mime = detectImageMime(buffer);
    if (!mime) {
      throw new PathSecurityError('Unsupported or invalid image file', 'INVALID_IMAGE_MIME');
    }

    return this.withStoryLock(safeId, () =>
      this.saveAssetUnlocked(safeId, safeFilename, buffer),
    );
  }

  async readAsset(id: string, filename: string): Promise<StoryAssetRecord | null> {
    const safeId = assertValidStoryId(id);
    const safeFilename = assertValidAssetFilename(filename);
    const { rootDir, mode } = await getStorageRoot();
    this.lastStorageMode = mode;
    const assetPath = resolveSafeChildPath(rootDir, 'stories', safeId, 'assets', safeFilename);

    let buffer: Buffer;
    try {
      buffer = await fs.readFile(assetPath);
    } catch (err) {
      if (getErrnoCode(err) === 'ENOENT') {
        return null;
      }
      throw err;
    }

    const mimeType = detectImageMime(buffer);
    if (!mimeType) {
      return null;
    }

    return { buffer, mimeType };
  }

  async deleteAsset(id: string, filename: string): Promise<boolean> {
    const safeId = assertValidStoryId(id);
    const safeFilename = assertValidAssetFilename(filename);
    return this.withStoryLock(safeId, () => this.deleteAssetUnlocked(safeId, safeFilename));
  }

  async purgeReferencePhotos(id: string): Promise<PurgeReferencePhotosResult | null> {
    const safeId = assertValidStoryId(id);

    return this.withStoryLock(safeId, async () => {
      const story = await this.getStoryUnlocked(safeId);
      if (!story) {
        return null;
      }

      const wasAlreadyPurged =
        Boolean(story.referencePhotosPurgedAt) && story.referencePhotos.length === 0;

      const candidates: string[] = [];
      const seen = new Set<string>();
      for (const filename of story.referencePhotos) {
        if (!seen.has(filename)) {
          seen.add(filename);
          candidates.push(filename);
        }
      }

      // Also sweep any orphaned ref-* files left on disk in the story's assets directory
      const { rootDir } = await getStorageRoot();
      const assetsDir = resolveSafeChildPath(rootDir, 'stories', safeId, 'assets');
      try {
        const entries = await fs.readdir(assetsDir, { withFileTypes: true });
        const orphans = entries
          .filter(
            (entry) =>
              entry.isFile() &&
              /^ref-/i.test(entry.name) &&
              ASSET_FILENAME_REGEX.test(entry.name) &&
              !entry.name.includes('..') &&
              !seen.has(entry.name),
          )
          .map((entry) => entry.name)
          .sort();
        for (const orphan of orphans) {
          seen.add(orphan);
          candidates.push(orphan);
        }
      } catch (err) {
        if (getErrnoCode(err) !== 'ENOENT') {
          throw err;
        }
      }

      const deletedFiles: string[] = [];
      for (const filename of candidates) {
        const safeFilename = assertValidAssetFilename(filename);
        const removed = await this.deleteAssetUnlocked(safeId, safeFilename);
        if (removed) {
          deletedFiles.push(safeFilename);
        }
      }

      // Idempotent timestamp preservation: never overwrite existing referencePhotosPurgedAt
      if (story.referencePhotosPurgedAt) {
        const purgedAt = story.referencePhotosPurgedAt;
        if (story.referencePhotos.length > 0) {
          await this.saveStoryUnlocked(safeId, {
            ...story,
            referencePhotos: [],
            updatedAt: new Date().toISOString(),
          });
        }
        return {
          storyId: safeId,
          deletedFiles,
          purgedAt,
          alreadyPurged: wasAlreadyPurged,
        };
      }

      const purgedAt = new Date().toISOString();
      await this.saveStoryUnlocked(safeId, {
        ...story,
        referencePhotos: [],
        referencePhotosPurgedAt: purgedAt,
        updatedAt: purgedAt,
      });

      return {
        storyId: safeId,
        deletedFiles,
        purgedAt,
        alreadyPurged: false,
      };
    });
  }

  private async getRuntimeSettingsUnlocked(): Promise<RuntimeSettings> {
    const envDefaults = getEnvRuntimeDefaults();
    const { rootDir, mode } = await getStorageRoot();
    this.lastStorageMode = mode;
    const settingsPath = resolveSafeChildPath(rootDir, 'config', 'settings.json');

    let raw: string;
    try {
      raw = await fs.readFile(settingsPath, 'utf8');
    } catch (err) {
      if (getErrnoCode(err) === 'ENOENT') {
        return envDefaults;
      }
      throw err;
    }

    try {
      const parsedJson: unknown = JSON.parse(raw);
      const validated = PartialRuntimeSettingsSchema.safeParse(parsedJson);
      if (!validated.success) {
        return envDefaults;
      }
      const merged: RuntimeSettings = { ...envDefaults };
      if (validated.data.activeProvider !== undefined) {
        merged.activeProvider = validated.data.activeProvider;
      }
      if (validated.data.textModel !== undefined) {
        merged.textModel = validated.data.textModel;
      }
      if (validated.data.imageModel !== undefined) {
        merged.imageModel = validated.data.imageModel;
      }
      if (validated.data.defaultPreviewFirst !== undefined) {
        merged.defaultPreviewFirst = validated.data.defaultPreviewFirst;
      }
      if (validated.data.defaultBookFormat !== undefined) {
        merged.defaultBookFormat = validated.data.defaultBookFormat;
      }
      if (validated.data.geminiImageSize !== undefined) {
        merged.geminiImageSize = validated.data.geminiImageSize;
      }
      return merged;
    } catch {
      return envDefaults;
    }
  }

  async getRuntimeSettings(): Promise<RuntimeSettings> {
    return this.getRuntimeSettingsUnlocked();
  }

  async saveRuntimeSettings(patch: Partial<RuntimeSettings>): Promise<RuntimeSettings> {
    const validatedPatch = PartialRuntimeSettingsSchema.parse(patch);

    return this.withSettingsLock(async () => {
      const current = await this.getRuntimeSettingsUnlocked();
      const next: RuntimeSettings = {
        activeProvider: validatedPatch.activeProvider ?? current.activeProvider,
        textModel: validatedPatch.textModel ?? current.textModel,
        imageModel: validatedPatch.imageModel ?? current.imageModel,
        defaultPreviewFirst: validatedPatch.defaultPreviewFirst ?? current.defaultPreviewFirst,
        defaultBookFormat: validatedPatch.defaultBookFormat ?? current.defaultBookFormat,
        geminiImageSize:
          validatedPatch.geminiImageSize ??
          current.geminiImageSize ??
          DEFAULT_GEMINI_IMAGE_SIZE,
      };

      const { rootDir, mode } = await getStorageRoot();
      this.lastStorageMode = mode;
      const settingsPath = resolveSafeChildPath(rootDir, 'config', 'settings.json');
      await writeFileAtomic(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
      return next;
    });
  }
}

const defaultRepository: StoryRepository = new FilesystemStoryRepository();
let activeRepository: StoryRepository = defaultRepository;

export function getStoryRepository(): StoryRepository {
  return activeRepository;
}

export function setStoryRepository(repository: StoryRepository): void {
  activeRepository = repository;
}

export function resetStoryRepository(): void {
  activeRepository = defaultRepository;
}
