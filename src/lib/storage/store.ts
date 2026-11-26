import crypto from 'node:crypto';
import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import {
  BookFormatSchema,
  DEFAULT_RUNTIME_SETTINGS,
  DEMO_ASSET_PATH_REGEX,
  ModelIdSchema,
  ProviderIdSchema,
  RuntimeSettingsSchema,
  StoryRecordSchema,
  type RuntimeSettings,
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
  sanitizeFileSlug,
  type AllowedImageMime,
} from './security';

export { DEFAULT_RUNTIME_SETTINGS };

export const MAX_ASSET_BYTES = 10 * 1024 * 1024; // 10 MB

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

function mapStoryToSummary(story: StoryRecord): StorySummary {
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
    createdAt: story.createdAt,
    updatedAt: story.updatedAt,
  };
}

function getEnvRuntimeDefaults(): RuntimeSettings {
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

export function generateStoryId(seed?: string): string {
  const slug = sanitizeFileSlug(seed ?? '', 'bajka', 24);
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex');
  const id = `${slug}-${ts}-${rand}`.slice(0, 64).replace(/[-_]+$/, '');
  return assertValidStoryId(id);
}

export async function saveStory(story: StoryRecord): Promise<void> {
  const safeId = assertValidStoryId(story.id);
  const validated = StoryRecordSchema.parse(story);
  const { rootDir } = await getStorageRoot();
  const storyPath = resolveSafeChildPath(rootDir, 'stories', safeId, 'story.json');
  await writeFileAtomic(storyPath, `${JSON.stringify(validated, null, 2)}\n`);
}

export async function getStory(id: string): Promise<StoryRecord | null> {
  const safeId = assertValidStoryId(id);
  const { rootDir } = await getStorageRoot();
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

export async function listStories(): Promise<StorySummary[]> {
  const { rootDir } = await getStorageRoot();
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
      const story = await getStory(entry.name);
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

export async function deleteStory(id: string): Promise<boolean> {
  const safeId = assertValidStoryId(id);
  const { rootDir } = await getStorageRoot();
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

export async function saveStoryAsset(
  id: string,
  filename: string,
  buffer: Buffer,
): Promise<string> {
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

  const { rootDir } = await getStorageRoot();
  const assetPath = resolveSafeChildPath(rootDir, 'stories', safeId, 'assets', safeFilename);
  await writeFileAtomic(assetPath, buffer);
  return safeFilename;
}

export async function readStoryAsset(
  id: string,
  filename: string,
): Promise<{ buffer: Buffer; mimeType: AllowedImageMime } | null> {
  const safeId = assertValidStoryId(id);
  const safeFilename = assertValidAssetFilename(filename);
  const { rootDir } = await getStorageRoot();
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

export async function getRuntimeSettings(): Promise<RuntimeSettings> {
  const envDefaults = getEnvRuntimeDefaults();
  const { rootDir } = await getStorageRoot();
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
    return merged;
  } catch {
    return envDefaults;
  }
}

export async function saveRuntimeSettings(
  patch: Partial<RuntimeSettings>,
): Promise<RuntimeSettings> {
  const validatedPatch = PartialRuntimeSettingsSchema.parse(patch);
  const current = await getRuntimeSettings();
  const next: RuntimeSettings = {
    activeProvider: validatedPatch.activeProvider ?? current.activeProvider,
    textModel: validatedPatch.textModel ?? current.textModel,
    imageModel: validatedPatch.imageModel ?? current.imageModel,
    defaultPreviewFirst: validatedPatch.defaultPreviewFirst ?? current.defaultPreviewFirst,
    defaultBookFormat: validatedPatch.defaultBookFormat ?? current.defaultBookFormat,
  };

  const { rootDir } = await getStorageRoot();
  const settingsPath = resolveSafeChildPath(rootDir, 'config', 'settings.json');
  await writeFileAtomic(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
