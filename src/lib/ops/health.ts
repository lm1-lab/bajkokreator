import fs from 'node:fs/promises';
import path from 'node:path';
import rawKnowledgeBase from '@/content/knowledge-base.json';
import rawCatalog from '@/content/themes.json';
import { getActiveProviderId, getProvider } from '@/lib/ai/provider';
import { ThemeCatalogSchema, getActiveThemes } from '@/lib/catalog/themes';
import { validateRuntimeConfig } from '@/lib/ops/config';
import { getDailyQuotaStatus } from '@/lib/storage/quota';
import { getStoryRepository } from '@/lib/storage/repository';
import { getRuntimeSettings } from '@/lib/storage/store';
import { KnowledgeBaseDocumentSchema } from '@/lib/support/knowledge-base';
import type { StorageMode } from '@/lib/types/story';

// =============================================================================
// System Health & Readiness Diagnostics (Public, Zero Secrets / Zero PII)
// =============================================================================

export const REQUIRED_FONT_FILES = [
  'Lora-Regular.ttf',
  'Lora-Bold.ttf',
  'Lora-Italic.ttf',
  'PlusJakartaSans-Regular.ttf',
  'PlusJakartaSans-SemiBold.ttf',
] as const;

export const REQUIRED_DEMO_ART_FILES = [
  'cover.jpg',
  'page-01.jpg',
  'page-02.jpg',
  'page-03.jpg',
  'page-04.jpg',
  'page-05.jpg',
  'page-06.jpg',
  'page-07.jpg',
  'page-08.jpg',
  'page-09.jpg',
  'page-10.jpg',
] as const;

export type HealthCheckStatus = 'pass' | 'warn' | 'fail';
export type SystemHealthStatus = 'ok' | 'degraded' | 'unhealthy';

export interface HealthCheckItem {
  name: string;
  status: HealthCheckStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface SystemHealthReport {
  status: SystemHealthStatus;
  timestamp: string;
  checks: Record<string, HealthCheckItem>;
}

export type CustomHealthCheck = () => Promise<HealthCheckItem> | HealthCheckItem;

export interface HealthCheckOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  now?: Date;
}

const customChecks = new Map<string, CustomHealthCheck>();

/**
 * Registers an extensible domain health check (e.g., M5 Knowledge Base check)
 * without modifying M1 health orchestration code.
 */
export function registerHealthCheck(name: string, check: CustomHealthCheck): () => void {
  customChecks.set(name, check);
  return () => {
    if (customChecks.get(name) === check) {
      customChecks.delete(name);
    }
  };
}

export function resetCustomHealthChecks(): void {
  customChecks.clear();
}

async function checkRequiredFiles(
  name: string,
  baseDir: string,
  requiredFiles: readonly string[],
  label: string,
): Promise<HealthCheckItem> {
  const missing: string[] = [];
  for (const filename of requiredFiles) {
    try {
      const stat = await fs.stat(path.join(baseDir, filename));
      if (!stat.isFile() || stat.size <= 0) {
        missing.push(filename);
      }
    } catch {
      missing.push(filename);
    }
  }

  const presentCount = requiredFiles.length - missing.length;
  if (missing.length > 0) {
    return {
      name,
      status: 'fail',
      message: `Brak wymaganych zasobów (${label}): ${missing.length}/${requiredFiles.length}.`,
      details: {
        missing,
        presentCount,
        requiredCount: requiredFiles.length,
      },
    };
  }

  return {
    name,
    status: 'pass',
    message: `Wszystkie zasoby (${label}) są dostępne (${presentCount}/${requiredFiles.length}).`,
    details: {
      presentCount,
      requiredCount: requiredFiles.length,
    },
  };
}

export async function checkSystemHealth(
  options: HealthCheckOptions = {},
): Promise<SystemHealthReport> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();

  const checks: Record<string, HealthCheckItem> = {};

  // 1. Storage check
  let detectedStorageMode: StorageMode | undefined;
  const repo = getStoryRepository();
  try {
    const info = await repo.getStorageInfo();
    detectedStorageMode = info.mode;
    if (!info.writable) {
      checks.storage = {
        name: 'storage',
        status: 'fail',
        message: 'Magazyn danych nie jest zapisywalny.',
        details: {
          mode: info.mode,
          repositoryKind: repo.kind,
          writable: false,
        },
      };
    } else if (info.mode === 'tmp-fallback') {
      checks.storage = {
        name: 'storage',
        status: 'warn',
        message: 'Magazyn działa w trybie tymczasowym tmp-fallback (dane ulotne).',
        details: {
          mode: info.mode,
          repositoryKind: repo.kind,
          writable: true,
        },
      };
    } else {
      checks.storage = {
        name: 'storage',
        status: 'pass',
        message: 'Magazyn danych jest dostępny i zapisywalny.',
        details: {
          mode: info.mode,
          repositoryKind: repo.kind,
          writable: true,
        },
      };
    }
  } catch {
    checks.storage = {
      name: 'storage',
      status: 'fail',
      message: 'Nie udało się zweryfikować stanu magazynu danych.',
      details: {
        repositoryKind: repo.kind,
        writable: false,
      },
    };
  }

  // 2. Bundled PDF TTF fonts check
  checks.fonts = await checkRequiredFiles(
    'fonts',
    path.join(cwd, 'public', 'fonts'),
    REQUIRED_FONT_FILES,
    'czcionki TTF PDF',
  );

  // 3. Bundled demo-art integrity check
  checks.demoArt = await checkRequiredFiles(
    'demoArt',
    path.join(cwd, 'public', 'demo-art'),
    REQUIRED_DEMO_ART_FILES,
    'ilustracje demo-art',
  );

  // 4. Seasonal & evergreen theme catalog validity check
  const parsedCatalog = ThemeCatalogSchema.safeParse(rawCatalog);
  if (!parsedCatalog.success) {
    checks.catalog = {
      name: 'catalog',
      status: 'fail',
      message: 'Katalog motywów themes.json nie przeszedł walidacji schematu.',
      details: {
        issueCount: parsedCatalog.error.issues.length,
      },
    };
  } else {
    const activeThemes = getActiveThemes(now, parsedCatalog.data.themes);
    if (activeThemes.length === 0) {
      checks.catalog = {
        name: 'catalog',
        status: 'fail',
        message: 'Katalog motywów nie ma żadnych aktywnych pozycji na bieżącą datę.',
        details: {
          version: parsedCatalog.data.version,
          totalThemes: parsedCatalog.data.themes.length,
          activeThemes: 0,
        },
      };
    } else {
      checks.catalog = {
        name: 'catalog',
        status: 'pass',
        message: `Katalog motywów jest poprawny (${activeThemes.length} aktywnych / ${parsedCatalog.data.themes.length} wszystkich).`,
        details: {
          version: parsedCatalog.data.version,
          totalThemes: parsedCatalog.data.themes.length,
          activeThemes: activeThemes.length,
        },
      };
    }
  }

  // 5. Runtime config check
  const configValidation = validateRuntimeConfig(env, { storageMode: detectedStorageMode });
  if (configValidation.errors.length > 0) {
    checks.config = {
      name: 'config',
      status: 'fail',
      message: `Wykryto błędy konfiguracji środowiska (${configValidation.errors.length}).`,
      details: {
        errorCount: configValidation.errors.length,
        warningCount: configValidation.warnings.length,
        errors: configValidation.errors,
        warnings: configValidation.warnings,
      },
    };
  } else if (configValidation.warnings.length > 0) {
    checks.config = {
      name: 'config',
      status: 'warn',
      message: `Konfiguracja poprawna z ostrzeżeniami (${configValidation.warnings.length}).`,
      details: {
        errorCount: 0,
        warningCount: configValidation.warnings.length,
        warnings: configValidation.warnings,
      },
    };
  } else {
    checks.config = {
      name: 'config',
      status: 'pass',
      message: 'Konfiguracja środowiska jest poprawna.',
      details: {
        errorCount: 0,
        warningCount: 0,
      },
    };
  }

  // 6 & 7. AI provider readiness + daily quota status
  let activeProviderConsumesQuota = false;
  try {
    const settings = await getRuntimeSettings();
    const providerId = getActiveProviderId(settings, env);
    const provider = getProvider(providerId);
    const providerStatus = provider.getStatus();
    activeProviderConsumesQuota = providerStatus.consumesQuota;

    if (!providerStatus.configured || !providerStatus.available) {
      checks.aiProvider = {
        name: 'aiProvider',
        status: 'warn',
        message: `Aktywny dostawca AI (${providerId}) wymaga dodatkowej konfiguracji.`,
        details: {
          activeProvider: providerId,
          consumesQuota: providerStatus.consumesQuota,
          configured: providerStatus.configured,
          available: providerStatus.available,
        },
      };
    } else {
      checks.aiProvider = {
        name: 'aiProvider',
        status: 'pass',
        message: `Dostawca AI (${providerId}) jest gotowy do pracy.`,
        details: {
          activeProvider: providerId,
          consumesQuota: providerStatus.consumesQuota,
          configured: true,
          available: true,
        },
      };
    }
  } catch {
    checks.aiProvider = {
      name: 'aiProvider',
      status: 'fail',
      message: 'Nie udało się odczytać stanu aktywnego dostawcy AI.',
    };
  }

  try {
    const quota = await getDailyQuotaStatus();
    const exhausted = quota.remaining === 0 && activeProviderConsumesQuota;
    checks.quota = {
      name: 'quota',
      status: exhausted ? 'warn' : 'pass',
      message: exhausted
        ? `Dzienny limit generowania obrazów został wyczerpany (${quota.used}/${quota.limit}).`
        : `Dzienny limit obrazów: ${quota.used}/${quota.limit} (pozostało ${quota.remaining}).`,
      details: {
        date: quota.date,
        used: quota.used,
        limit: quota.limit,
        remaining: quota.remaining,
      },
    };
  } catch {
    checks.quota = {
      name: 'quota',
      status: 'fail',
      message: 'Nie udało się odczytać dziennego limitu generowania obrazów.',
    };
  }

  // 7b. Knowledge Base integrity check
  const parsedKb = KnowledgeBaseDocumentSchema.safeParse(rawKnowledgeBase);
  if (!parsedKb.success) {
    checks.knowledgeBase = {
      name: 'knowledgeBase',
      status: 'fail',
      message: 'Baza wiedzy obsługi klienta (knowledge-base.json) nie przechodzi walidacji schematu.',
    };
  } else {
    const confirmedCount = parsedKb.data.articles.filter(
      (a) => a.policyStatus === 'confirmed',
    ).length;
    checks.knowledgeBase = {
      name: 'knowledgeBase',
      status: 'pass',
      message: `Baza wiedzy zawiera ${parsedKb.data.articles.length} artykułów (${confirmedCount} potwierdzonych).`,
      details: {
        totalArticles: parsedKb.data.articles.length,
        confirmedCount,
      },
    };
  }

  // 8. Extensible custom checks
  for (const [name, fn] of customChecks.entries()) {
    try {
      checks[name] = await fn();
    } catch {
      checks[name] = {
        name,
        status: 'fail',
        message: `Kontrola stanu "${name}" zakończyła się błędem.`,
      };
    }
  }

  const allStatuses = Object.values(checks).map((c) => c.status);
  let status: SystemHealthStatus = 'ok';
  if (allStatuses.includes('fail')) {
    status = 'unhealthy';
  } else if (allStatuses.includes('warn')) {
    status = 'degraded';
  }

  return {
    status,
    timestamp: now.toISOString(),
    checks,
  };
}
