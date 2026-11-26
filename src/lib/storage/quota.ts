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
  }
}

let quotaLock: Promise<void> = Promise.resolve();

async function withQuotaLock<T>(task: () => Promise<T>): Promise<T> {
  const previous = quotaLock;
  let release!: () => void;
  quotaLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await task();
  } finally {
    release();
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

async function getQuotaFilePath(): Promise<string> {
  const { rootDir } = await getStorageRoot();
  return resolveSafeChildPath(rootDir, 'quota', 'daily-usage.json');
}

async function readUsedForDate(quotaFilePath: string, today: string): Promise<number> {
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
      record.date !== today ||
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

export function getDailyImageLimit(): number {
  const raw = process.env.MAX_DAILY_IMAGE_GENERATIONS?.trim();
  if (!raw || !/^\d+$/.test(raw)) {
    return DEFAULT_DAILY_IMAGE_LIMIT;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : DEFAULT_DAILY_IMAGE_LIMIT;
}

export async function getDailyQuotaStatus(): Promise<DailyQuotaStatus> {
  return withQuotaLock(async () => {
    const today = getUtcDateKey();
    const limit = getDailyImageLimit();
    const quotaFilePath = await getQuotaFilePath();
    const used = await readUsedForDate(quotaFilePath, today);
    return {
      date: today,
      used,
      limit,
      remaining: Math.max(0, limit - used),
    };
  });
}

export async function reserveDailyQuota(count: number): Promise<DailyQuotaStatus> {
  assertNonNegativeInteger(count);

  return withQuotaLock(async () => {
    const today = getUtcDateKey();
    const limit = getDailyImageLimit();
    const quotaFilePath = await getQuotaFilePath();
    const used = await readUsedForDate(quotaFilePath, today);

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

export async function releaseDailyQuota(count: number): Promise<void> {
  assertNonNegativeInteger(count);
  if (count === 0) {
    return;
  }

  await withQuotaLock(async () => {
    const today = getUtcDateKey();
    const quotaFilePath = await getQuotaFilePath();
    const used = await readUsedForDate(quotaFilePath, today);
    const nextUsed = Math.max(0, used - count);
    const state: PersistedQuotaState = {
      date: today,
      used: nextUsed,
      updatedAt: new Date().toISOString(),
    };
    await writeFileAtomic(quotaFilePath, `${JSON.stringify(state, null, 2)}\n`);
  });
}
