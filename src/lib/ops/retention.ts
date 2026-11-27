import { DEFAULT_RETENTION_MAX_AGE_HOURS } from '@/lib/ops/config';
import { getDomainEventBus, getMetricsSink } from '@/lib/ops/event-bus';
import { getOperationalLogger, redactPii } from '@/lib/ops/logger';
import { hasActiveOrderLockingStory } from '@/lib/orders/repository';
import { getStoryRepository } from '@/lib/storage/repository';

export { DEFAULT_RETENTION_MAX_AGE_HOURS };

// =============================================================================
// Automated Order-Safe GDPR/RODO Reference Photo Retention Sweep
// =============================================================================

export type OrderLockChecker = (storyId: string) => Promise<boolean>;

export interface RetentionPolicy {
  maxAgeHoursAfterCreation: number;
  dryRun: boolean;
  protectIncompleteStories: boolean;
  isStoryLockedByOrder?: OrderLockChecker;
  now?: Date;
}

export type RetentionEntryAction =
  | 'purged'
  | 'would_purge'
  | 'skipped_already_purged'
  | 'skipped_too_recent'
  | 'skipped_incomplete'
  | 'skipped_locked_by_order'
  | 'error';

export interface RetentionSweepEntry {
  storyId: string;
  action: RetentionEntryAction;
  ageHours: number;
  referencePhotosCount: number;
  deletedFiles?: string[];
  purgedAt?: string;
  reason?: string;
}

export interface RetentionSweepSummary {
  executedAt: string;
  dryRun: boolean;
  policy: {
    maxAgeHoursAfterCreation: number;
    protectIncompleteStories: boolean;
  };
  scanned: number;
  eligible: number;
  purged: number;
  skippedAlreadyPurged: number;
  skippedTooRecent: number;
  skippedIncomplete: number;
  skippedLockedByOrder: number;
  errors: number;
  entries: RetentionSweepEntry[];
}

const defaultOrderLockChecker: OrderLockChecker = async (storyId) =>
  hasActiveOrderLockingStory(storyId);
let activeOrderLockChecker: OrderLockChecker = defaultOrderLockChecker;

export function getOrderLockChecker(): OrderLockChecker {
  return activeOrderLockChecker;
}

export function setOrderLockChecker(checker: OrderLockChecker): void {
  activeOrderLockChecker = checker;
}

export function resetOrderLockChecker(): void {
  activeOrderLockChecker = defaultOrderLockChecker;
}

export function getDefaultRetentionMaxAgeHours(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw =
    env.BAJKOKREATOR_RETENTION_MAX_AGE_HOURS?.trim() ??
    env.BAJKOKREATOR_RODO_RETENTION_HOURS?.trim();
  if (!raw) {
    return DEFAULT_RETENTION_MAX_AGE_HOURS;
  }
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 87_600) {
    return parsed;
  }
  return DEFAULT_RETENTION_MAX_AGE_HOURS;
}

export async function runRetentionSweep(
  input: Partial<RetentionPolicy> = {},
): Promise<RetentionSweepSummary> {
  const maxAgeHoursAfterCreation =
    input.maxAgeHoursAfterCreation ?? getDefaultRetentionMaxAgeHours();
  if (!Number.isFinite(maxAgeHoursAfterCreation) || maxAgeHoursAfterCreation < 0) {
    throw new RangeError('maxAgeHoursAfterCreation must be a finite number >= 0');
  }

  const dryRun = input.dryRun ?? false;
  const protectIncompleteStories = input.protectIncompleteStories ?? true;
  const checkLocked = input.isStoryLockedByOrder ?? getOrderLockChecker();
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const executedAt = now.toISOString();

  const repo = getStoryRepository();
  const stories = await repo.listStories();

  let scanned = 0;
  let eligible = 0;
  let purged = 0;
  let skippedAlreadyPurged = 0;
  let skippedTooRecent = 0;
  let skippedIncomplete = 0;
  let skippedLockedByOrder = 0;
  let errors = 0;
  const entries: RetentionSweepEntry[] = [];

  for (const story of stories) {
    scanned += 1;
    const createdMs = Date.parse(story.createdAt);
    const rawAgeHours = Number.isNaN(createdMs)
      ? 0
      : Math.max(0, (nowMs - createdMs) / 3_600_000);
    const ageHours = Number(rawAgeHours.toFixed(2));

    if (story.referencePhotosCount === 0) {
      skippedAlreadyPurged += 1;
      entries.push({
        storyId: story.id,
        action: 'skipped_already_purged',
        ageHours,
        referencePhotosCount: 0,
        ...(story.referencePhotosPurgedAt ? { purgedAt: story.referencePhotosPurgedAt } : {}),
      });
      continue;
    }

    if (rawAgeHours < maxAgeHoursAfterCreation) {
      skippedTooRecent += 1;
      entries.push({
        storyId: story.id,
        action: 'skipped_too_recent',
        ageHours,
        referencePhotosCount: story.referencePhotosCount,
      });
      continue;
    }

    if (protectIncompleteStories && story.generationStage !== 'complete') {
      skippedIncomplete += 1;
      entries.push({
        storyId: story.id,
        action: 'skipped_incomplete',
        ageHours,
        referencePhotosCount: story.referencePhotosCount,
        reason: `stage=${story.generationStage}`,
      });
      continue;
    }

    let locked = false;
    try {
      locked = await checkLocked(story.id);
    } catch (err) {
      // Fail closed: never purge when order-lock status cannot be verified
      errors += 1;
      const reason = redactPii(err instanceof Error ? err.message : String(err)).slice(0, 200);
      getOperationalLogger().warn('retention', 'order_lock_check_failed', {
        storyId: story.id,
        error: err,
      });
      entries.push({
        storyId: story.id,
        action: 'error',
        ageHours,
        referencePhotosCount: story.referencePhotosCount,
        reason: `order_lock_check_failed: ${reason}`,
      });
      continue;
    }

    if (locked) {
      skippedLockedByOrder += 1;
      entries.push({
        storyId: story.id,
        action: 'skipped_locked_by_order',
        ageHours,
        referencePhotosCount: story.referencePhotosCount,
        reason: 'active_order_lock',
      });
      continue;
    }

    eligible += 1;

    if (dryRun) {
      entries.push({
        storyId: story.id,
        action: 'would_purge',
        ageHours,
        referencePhotosCount: story.referencePhotosCount,
      });
      continue;
    }

    try {
      const result = await repo.purgeReferencePhotos(story.id);
      if (!result) {
        errors += 1;
        entries.push({
          storyId: story.id,
          action: 'error',
          ageHours,
          referencePhotosCount: story.referencePhotosCount,
          reason: 'story_not_found_during_purge',
        });
        continue;
      }

      purged += 1;
      if (!result.alreadyPurged || result.deletedFiles.length > 0) {
        await getDomainEventBus().publish({
          type: 'story.reference_photos_purged',
          occurredAt: result.purgedAt,
          storyId: result.storyId,
          deletedCount: result.deletedFiles.length,
        });
      }

      entries.push({
        storyId: story.id,
        action: 'purged',
        ageHours,
        referencePhotosCount: story.referencePhotosCount,
        deletedFiles: result.deletedFiles,
        purgedAt: result.purgedAt,
      });
    } catch (err) {
      errors += 1;
      const reason = redactPii(err instanceof Error ? err.message : String(err)).slice(0, 200);
      getOperationalLogger().error('retention', 'purge_failed', {
        storyId: story.id,
        error: err,
      });
      entries.push({
        storyId: story.id,
        action: 'error',
        ageHours,
        referencePhotosCount: story.referencePhotosCount,
        reason,
      });
    }
  }

  const metrics = getMetricsSink();
  metrics.increment('rodo.retention_sweeps', 1, { dryRun });
  if (purged > 0) {
    metrics.increment('rodo.retention_sweeps.purged_stories', purged);
  }
  if (errors > 0) {
    metrics.increment('rodo.retention_sweeps.errors', errors);
  }

  return {
    executedAt,
    dryRun,
    policy: {
      maxAgeHoursAfterCreation,
      protectIncompleteStories,
    },
    scanned,
    eligible,
    purged,
    skippedAlreadyPurged,
    skippedTooRecent,
    skippedIncomplete,
    skippedLockedByOrder,
    errors,
    entries,
  };
}
