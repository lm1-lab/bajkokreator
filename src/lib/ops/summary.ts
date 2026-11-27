import { getActiveProviderId } from '@/lib/ai/provider';
import {
  getActiveThemes,
  getUpcomingSeasonalThemes,
  type ActiveDateWindow,
  type ThemeSeason,
} from '@/lib/catalog/themes';
import { validateRuntimeConfig } from '@/lib/ops/config';
import { listRecentDiagnostics } from '@/lib/ops/diagnostics';
import { runRetentionSweep } from '@/lib/ops/retention';
import { computeLiveOrderMetrics } from '@/lib/orders/repository';
import { getDailyQuotaStatus } from '@/lib/storage/quota';
import { getStoryRepository } from '@/lib/storage/repository';
import { getRuntimeSettings } from '@/lib/storage/store';
import {
  BOOK_FORMATS,
  DEFAULT_GEMINI_IMAGE_SIZE,
  GENERATION_STAGES,
  PROVIDER_IDS,
  type BookFormat,
  type DailyQuotaStatus,
  type GeminiImageSize,
  type GenerationStage,
  type ProviderId,
  type StorageMode,
} from '@/lib/types/story';

// =============================================================================
// Operator Read-Only Status Summary & Pluggable Order Metrics Port
// Zero PII / zero secrets: aggregates counts, quota, RODO eligibility,
// upcoming seasonal deadlines, and redacted diagnostics.
// =============================================================================

export interface OpsOrderMetrics {
  available: boolean;
  total: number;
  byStatus: Partial<Record<string, number>>;
  awaitingApproval: number;
  preflightFailed: number;
  readyForPrintSubmission: number;
}

export type OrderMetricsProvider = () => Promise<OpsOrderMetrics>;

const DEFAULT_ORDER_METRICS: OpsOrderMetrics = {
  available: false,
  total: 0,
  byStatus: {},
  awaitingApproval: 0,
  preflightFailed: 0,
  readyForPrintSubmission: 0,
};

let activeOrderMetricsProvider: OrderMetricsProvider | null = null;

export function setOrderMetricsProvider(provider: OrderMetricsProvider | null): void {
  activeOrderMetricsProvider = provider;
}

export function getOrderMetricsProvider(): OrderMetricsProvider | null {
  return activeOrderMetricsProvider;
}

export function resetOrderMetricsProvider(): void {
  activeOrderMetricsProvider = null;
}

export interface OpsStatusSummary {
  generatedAt: string;
  stories: {
    total: number;
    byStage: Record<GenerationStage, number>;
    byProvider: Record<ProviderId, number>;
    byFormat: Record<BookFormat, number>;
  };
  quota: DailyQuotaStatus & { utilizationPercent: number };
  storage: {
    mode: StorageMode;
    writable: boolean;
    repositoryKind: string;
  };
  runtime: {
    activeProvider: ProviderId;
    textModel: string;
    imageModel: string;
    imageSize: GeminiImageSize;
  };
  rodo: {
    storiesWithReferencePhotos: number;
    totalReferencePhotosStored: number;
    storiesAlreadyPurged: number;
    eligibleForRetentionPurge: number;
    retentionMaxAgeHours: number;
  };
  seasonal: {
    referenceDate: string;
    activeSeasonalThemes: Array<{
      id: string;
      label: string;
      season: ThemeSeason;
      activeWindow?: ActiveDateWindow;
    }>;
    upcomingSeasonalDeadlines: Array<{
      id: string;
      label: string;
      season: ThemeSeason;
      startsInDays: number;
      startMonthDay: string;
      endMonthDay: string;
    }>;
  };
  diagnostics: {
    recentFailureCount24h: number;
    totalRecordedFailures: number;
    recentFailures: Array<{
      timestamp: string;
      operation: string;
      storyId?: string;
      provider?: string;
      code: string;
      message: string;
    }>;
  };
  config: {
    ok: boolean;
    errorCount: number;
    warningCount: number;
  };
  orders: OpsOrderMetrics;
}

export interface BuildOpsSummaryOptions {
  now?: Date;
  upcomingDays?: number;
  retentionMaxAgeHours?: number;
  recentFailuresLimit?: number;
}

export async function buildOpsSummary(
  options: BuildOpsSummaryOptions = {},
): Promise<OpsStatusSummary> {
  const now = options.now ?? new Date();
  const upcomingDays = Math.max(1, Math.min(365, Math.floor(options.upcomingDays ?? 60)));
  const recentFailuresLimit = Math.max(
    1,
    Math.min(100, Math.floor(options.recentFailuresLimit ?? 10)),
  );

  const repo = getStoryRepository();
  const [stories, quota, storageInfo, settings, recent24h, allRecent] = await Promise.all([
    repo.listStories(),
    getDailyQuotaStatus(),
    repo.getStorageInfo(),
    getRuntimeSettings(),
    listRecentDiagnostics(1000, 24, now.getTime()),
    listRecentDiagnostics(1000, undefined, now.getTime()),
  ]);

  const configValidation = validateRuntimeConfig(process.env, {
    storageMode: storageInfo.mode,
  });
  const retentionMaxAgeHours =
    options.retentionMaxAgeHours ?? configValidation.config.retentionMaxAgeHours;

  const byStage = Object.fromEntries(
    GENERATION_STAGES.map((stage) => [stage, 0]),
  ) as Record<GenerationStage, number>;
  const byProvider = Object.fromEntries(
    PROVIDER_IDS.map((provider) => [provider, 0]),
  ) as Record<ProviderId, number>;
  const byFormat = Object.fromEntries(
    BOOK_FORMATS.map((fmt) => [fmt, 0]),
  ) as Record<BookFormat, number>;

  let storiesWithReferencePhotos = 0;
  let totalReferencePhotosStored = 0;
  let storiesAlreadyPurged = 0;

  for (const story of stories) {
    byStage[story.generationStage] += 1;
    byProvider[story.provider] += 1;
    byFormat[story.bookFormat] += 1;
    if (story.referencePhotosCount > 0) {
      storiesWithReferencePhotos += 1;
      totalReferencePhotosStored += story.referencePhotosCount;
    }
    if (story.referencePhotosPurgedAt) {
      storiesAlreadyPurged += 1;
    }
  }

  const dryRunSweep = await runRetentionSweep({
    dryRun: true,
    maxAgeHoursAfterCreation: retentionMaxAgeHours,
    protectIncompleteStories: true,
    now,
  });

  const activeProvider = getActiveProviderId(settings);
  const utilizationPercent =
    quota.limit > 0 ? Number(((quota.used / quota.limit) * 100).toFixed(1)) : 100;

  const activeSeasonalThemes = getActiveThemes(now)
    .filter((item) => item.season !== 'evergreen' || Boolean(item.activeWindow))
    .map((item) => ({
      id: item.id,
      label: item.label,
      season: item.season,
      ...(item.activeWindow ? { activeWindow: item.activeWindow } : {}),
    }));

  const upcomingSeasonalDeadlines = getUpcomingSeasonalThemes(now, upcomingDays)
    .filter((entry) => Boolean(entry.theme.activeWindow))
    .map((entry) => ({
      id: entry.theme.id,
      label: entry.theme.label,
      season: entry.theme.season,
      startsInDays: entry.startsInDays,
      startMonthDay: entry.theme.activeWindow!.startMonthDay,
      endMonthDay: entry.theme.activeWindow!.endMonthDay,
    }));

  let orders: OpsOrderMetrics = { ...DEFAULT_ORDER_METRICS };
  const metricsProvider = activeOrderMetricsProvider ?? computeLiveOrderMetrics;
  try {
    orders = await metricsProvider();
  } catch {
    orders = { ...DEFAULT_ORDER_METRICS };
  }

  return {
    generatedAt: now.toISOString(),
    stories: {
      total: stories.length,
      byStage,
      byProvider,
      byFormat,
    },
    quota: {
      ...quota,
      utilizationPercent,
    },
    storage: {
      mode: storageInfo.mode,
      writable: storageInfo.writable,
      repositoryKind: repo.kind,
    },
    runtime: {
      activeProvider,
      textModel: settings.textModel,
      imageModel: settings.imageModel,
      imageSize: settings.geminiImageSize ?? DEFAULT_GEMINI_IMAGE_SIZE,
    },
    rodo: {
      storiesWithReferencePhotos,
      totalReferencePhotosStored,
      storiesAlreadyPurged,
      eligibleForRetentionPurge: dryRunSweep.eligible,
      retentionMaxAgeHours,
    },
    seasonal: {
      referenceDate: now.toISOString().slice(0, 10),
      activeSeasonalThemes,
      upcomingSeasonalDeadlines,
    },
    diagnostics: {
      recentFailureCount24h: recent24h.length,
      totalRecordedFailures: allRecent.length,
      recentFailures: allRecent.slice(0, recentFailuresLimit).map((r) => ({
        timestamp: r.timestamp,
        operation: r.operation,
        ...(r.storyId ? { storyId: r.storyId } : {}),
        ...(r.provider ? { provider: r.provider } : {}),
        code: r.errorCode,
        message: r.errorMessage,
      })),
    },
    config: {
      ok: configValidation.ok,
      errorCount: configValidation.errors.length,
      warningCount: configValidation.warnings.length,
    },
    orders,
  };
}
