import crypto from 'node:crypto';
import {
  DEFAULT_RUNTIME_SETTINGS,
  type RuntimeSettings,
  type StoryRecord,
  type StorySummary,
} from '@/lib/types/story';
import {
  DEFAULT_DAILY_IMAGE_LIMIT,
  QuotaExceededError,
  checkDailyQuotaAvailable,
  getDailyImageLimit,
  getDailyQuotaStatus,
  getQuotaRepository,
  releaseDailyQuota,
  reserveDailyQuota,
  resetQuotaRepository,
  setQuotaRepository,
  type QuotaAvailability,
  type QuotaRepository,
} from './quota';
import {
  MAX_ASSET_BYTES,
  getStoryRepository,
  resetStoryRepository,
  setStoryRepository,
  type PurgeReferencePhotosResult,
  type StorageInfo,
  type StoryAssetRecord,
  type StoryRepository,
} from './repository';
import { assertValidStoryId, sanitizeFileSlug } from './security';

export {
  DEFAULT_DAILY_IMAGE_LIMIT,
  DEFAULT_RUNTIME_SETTINGS,
  MAX_ASSET_BYTES,
  QuotaExceededError,
  checkDailyQuotaAvailable,
  getDailyImageLimit,
  getDailyQuotaStatus,
  getQuotaRepository,
  getStoryRepository,
  releaseDailyQuota,
  reserveDailyQuota,
  resetQuotaRepository,
  resetStoryRepository,
  setQuotaRepository,
  setStoryRepository,
  type PurgeReferencePhotosResult,
  type QuotaAvailability,
  type QuotaRepository,
  type StorageInfo,
  type StoryAssetRecord,
  type StoryRepository,
};

export function generateStoryId(seed?: string): string {
  const slug = sanitizeFileSlug(seed ?? '', 'bajka', 24);
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex');
  const id = `${slug}-${ts}-${rand}`.slice(0, 64).replace(/[-_]+$/, '');
  return assertValidStoryId(id);
}

export async function getStorageInfo(): Promise<StorageInfo> {
  return getStoryRepository().getStorageInfo();
}

export async function saveStory(story: StoryRecord): Promise<void> {
  return getStoryRepository().saveStory(story);
}

export async function updateStory(
  id: string,
  updater: (story: StoryRecord) => Promise<StoryRecord | null> | StoryRecord | null,
): Promise<StoryRecord | null> {
  const repo = getStoryRepository();
  if (typeof repo.updateStory === 'function') {
    return repo.updateStory(id, updater);
  }
  const existing = await repo.getStory(id);
  if (!existing) {
    return null;
  }
  const next = await updater(existing);
  if (!next) {
    return null;
  }
  await repo.saveStory(next);
  return next;
}

export async function getStory(id: string): Promise<StoryRecord | null> {
  return getStoryRepository().getStory(id);
}

export async function listStories(): Promise<StorySummary[]> {
  return getStoryRepository().listStories();
}

export async function deleteStory(id: string): Promise<boolean> {
  return getStoryRepository().deleteStory(id);
}

export async function saveStoryAsset(
  id: string,
  filename: string,
  buffer: Buffer,
): Promise<string> {
  return getStoryRepository().saveAsset(id, filename, buffer);
}

export async function readStoryAsset(
  id: string,
  filename: string,
): Promise<StoryAssetRecord | null> {
  return getStoryRepository().readAsset(id, filename);
}

export async function deleteStoryAsset(id: string, filename: string): Promise<boolean> {
  return getStoryRepository().deleteAsset(id, filename);
}

export async function purgeStoryReferencePhotos(
  id: string,
): Promise<PurgeReferencePhotosResult | null> {
  return getStoryRepository().purgeReferencePhotos(id);
}

export async function getRuntimeSettings(): Promise<RuntimeSettings> {
  return getStoryRepository().getRuntimeSettings();
}

export async function saveRuntimeSettings(
  patch: Partial<RuntimeSettings>,
): Promise<RuntimeSettings> {
  return getStoryRepository().saveRuntimeSettings(patch);
}
