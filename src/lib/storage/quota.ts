import fs from 'node:fs/promises';
import type { DailyQuotaStatus } from '@/lib/types/story';
import { getStorageRoot, writeFileAtomic } from './paths';
import { resolveSafeChildPath } from './security';

export type { DailyQuotaStatus };

export const DEFAULT_DAILY_IMAGE_LIMIT = 30;

interface PersistedQuotaState {
  date: string;
  used: number;
  updatedAt: string;
}

export interface QuotaAvailability {
  available: boolean;
  requested: number;
  status: DailyQuotaStatus;
}

/**
 * Vendor-agnostic persistence port for daily AI image generation quota tracking.
 * Swap in a Redis / Postgres / Upstash implementation via `setQuotaRepository()`.
 */
export interface QuotaRepository {
  readonly kind: string;
  getDailyUsage(dateKey?: string): Promise<DailyQuotaStatus>;
  checkQuotaAvailable(count: number, dateKey?: string): Promise<QuotaAvailability>;
  reserveImageQuota(count: number, dateKey?: string): Promise<DailyQuotaStatus>;
  releaseImageQuota(count: number, dateKey?: string): Promise<void>;
}

export class QuotaExceededError extends Error {
  public readonly httpStatus = 429;
  public readonly code = 'DAILY_QUOTA_EXCEEDED';
  public readonly status: DailyQuotaStatus;
  public readonly requested: number;

  constructor(status: DailyQuotaStatus, requested: number) {
    super(
      `Przekroczono dzienny limit generowania ilustracji (${status.used}/${status.limit}, żądano ${requested}).`,
    );
    this.name = 'QuotaExceededError';
    this.status = status;
    this.requested = requested;
    Object.setPrototypeOf(this, QuotaExceededError.prototype);
  }
}

function getErrnoCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function getUtcDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function assertNonNegativeInteger(count: number): void {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError('Quota count must be a non-negative integer');
  }
}

export function getDailyImageLimit(): number {
  const raw = process.env.MAX_DAILY_IMAGE_GENERATIONS?.trim();
  if (!raw || !/^\d+$/.test(raw)) {
    return DEFAULT_DAILY_IMAGE_LIMIT;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : DEFAULT_DAILY_IMAGE_LIMIT;
}

export class FilesystemQuotaRepository implements QuotaRepository {
  readonly kind = 'filesystem';
  private lock: Promise<void> = Promise.resolve();

  private async withLock<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }

  private async getQuotaFilePath(): Promise<string> {
    const { rootDir } = await getStorageRoot();
    return resolveSafeChildPath(rootDir, 'quota', 'daily-usage.json');
  }

  private async readUsedForDate(quotaFilePath: string, dateKey: string): Promise<number> {
    let raw: string;
    try {
      raw = await fs.readFile(quotaFilePath, 'utf8');
    } catch (err) {
      if (getErrnoCode(err) === 'ENOENT') {
        return 0;
      }
      throw err;
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) {
        return 0;
      }
      const record = parsed as Partial<PersistedQuotaState>;
      if (
        record.date !== dateKey ||
        typeof record.used !== 'number' ||
        !Number.isSafeInteger(record.used) ||
        record.used < 0
      ) {
        return 0;
      }
      return record.used;
    } catch {
      return 0;
    }
  }

  async getDailyUsage(dateKey?: string): Promise<DailyQuotaStatus> {
    return this.withLock(async () => {
      const today = dateKey ?? getUtcDateKey();
      const limit = getDailyImageLimit();
      const quotaFilePath = await this.getQuotaFilePath();
      const used = await this.readUsedForDate(quotaFilePath, today);
      return {
        date: today,
        used,
        limit,
        remaining: Math.max(0, limit - used),
      };
    });
  }

  async checkQuotaAvailable(count: number, dateKey?: string): Promise<QuotaAvailability> {
    assertNonNegativeInteger(count);

    return this.withLock(async () => {
      const today = dateKey ?? getUtcDateKey();
      const limit = getDailyImageLimit();
      const quotaFilePath = await this.getQuotaFilePath();
      const used = await this.readUsedForDate(quotaFilePath, today);
      const status: DailyQuotaStatus = {
        date: today,
        used,
        limit,
        remaining: Math.max(0, limit - used),
      };
      return {
        available: used + count <= limit,
        requested: count,
        status,
      };
    });
  }

  async reserveImageQuota(count: number, dateKey?: string): Promise<DailyQuotaStatus> {
    assertNonNegativeInteger(count);

    return this.withLock(async () => {
      const today = dateKey ?? getUtcDateKey();
      const limit = getDailyImageLimit();
      const quotaFilePath = await this.getQuotaFilePath();
      const used = await this.readUsedForDate(quotaFilePath, today);

      if (count === 0) {
        return {
          date: today,
          used,
          limit,
          remaining: Math.max(0, limit - used),
        };
      }

      if (used + count > limit) {
        throw new QuotaExceededError(
          {
            date: today,
            used,
            limit,
            remaining: Math.max(0, limit - used),
          },
          count,
        );
      }

      const nextUsed = used + count;
      const state: PersistedQuotaState = {
        date: today,
        used: nextUsed,
        updatedAt: new Date().toISOString(),
      };
      await writeFileAtomic(quotaFilePath, `${JSON.stringify(state, null, 2)}\n`);

      return {
        date: today,
        used: nextUsed,
        limit,
        remaining: Math.max(0, limit - nextUsed),
      };
    });
  }

  async releaseImageQuota(count: number, dateKey?: string): Promise<void> {
    assertNonNegativeInteger(count);
    if (count === 0) {
      return;
    }

    await this.withLock(async () => {
      const today = dateKey ?? getUtcDateKey();
      const quotaFilePath = await this.getQuotaFilePath();
      const used = await this.readUsedForDate(quotaFilePath, today);
      const nextUsed = Math.max(0, used - count);
      const state: PersistedQuotaState = {
        date: today,
        used: nextUsed,
        updatedAt: new Date().toISOString(),
      };
      await writeFileAtomic(quotaFilePath, `${JSON.stringify(state, null, 2)}\n`);
    });
  }
}

const defaultQuotaRepository: QuotaRepository = new FilesystemQuotaRepository();
let activeQuotaRepository: QuotaRepository = defaultQuotaRepository;

export function getQuotaRepository(): QuotaRepository {
  return activeQuotaRepository;
}

export function setQuotaRepository(repository: QuotaRepository): void {
  activeQuotaRepository = repository;
}

export function resetQuotaRepository(): void {
  activeQuotaRepository = defaultQuotaRepository;
}

export async function getDailyQuotaStatus(): Promise<DailyQuotaStatus> {
  return getQuotaRepository().getDailyUsage();
}

export async function checkDailyQuotaAvailable(count: number): Promise<QuotaAvailability> {
  return getQuotaRepository().checkQuotaAvailable(count);
}

export async function reserveDailyQuota(count: number): Promise<DailyQuotaStatus> {
  return getQuotaRepository().reserveImageQuota(count);
}

export async function releaseDailyQuota(count: number): Promise<void> {
  return getQuotaRepository().releaseImageQuota(count);
}
