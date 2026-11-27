import { z } from 'zod';
import type { LogLevel } from '@/lib/ops/logger';
import { DEFAULT_DAILY_IMAGE_LIMIT } from '@/lib/storage/quota';
import {
  AuthStrategySchema,
  BookFormatSchema,
  DEFAULT_GEMINI_IMAGE_SIZE,
  DEFAULT_RUNTIME_SETTINGS,
  GeminiImageSizeSchema,
  ModelIdSchema,
  ProviderIdSchema,
  type AuthStrategy,
  type BookFormat,
  type GeminiImageSize,
  type ProviderId,
  type StorageMode,
} from '@/lib/types/story';

// =============================================================================
// Centralized Zod-Backed Environment & Runtime Configuration Validator
// Surfaces explicit warnings/errors instead of silent fallbacks and NEVER
// exposes raw secrets in its returned config snapshot.
// =============================================================================

export const DEFAULT_RETENTION_MAX_AGE_HOURS = 24 * 30; // 720 hours (30 days)

const SubscriptionTierSchema = z.enum(['ai-pro', 'ai-ultra']);
const LogLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);
const NonNegativeIntStringSchema = z.string().regex(/^\d+$/);
const BooleanEnvStringSchema = z.enum(['true', 'false', '1', '0']);

export interface ConfigDiagnostic {
  code: string;
  field: string;
  severity: 'warning' | 'error';
  message: string;
}

export interface ValidatedRuntimeConfig {
  nodeEnv: string;
  isProduction: boolean;
  isVercel: boolean;
  dataDir: string | null;
  aiProvider: ProviderId;
  geminiTextModel: string;
  geminiImageModel: string;
  geminiImageSize: GeminiImageSize;
  maxDailyImageGenerations: number;
  defaultPreviewFirst: boolean;
  defaultBookFormat: BookFormat;
  googleAuthStrategy: AuthStrategy;
  googleSubscriptionTier: 'ai-pro' | 'ai-ultra';
  hasGeminiApiKey: boolean;
  hasSubscriptionEndpoint: boolean;
  hasSubscriptionToken: boolean;
  hasSubscriptionClientId: boolean;
  hasOpsToken: boolean;
  requireOpsAuth: boolean;
  logLevel: LogLevel;
  rateLimitDisabled: boolean;
  retentionMaxAgeHours: number;
}

export interface RuntimeConfigValidationResult {
  ok: boolean;
  warnings: ConfigDiagnostic[];
  errors: ConfigDiagnostic[];
  config: ValidatedRuntimeConfig;
}

export interface ValidateRuntimeConfigOptions {
  storageMode?: StorageMode;
}

function isAllowedSubscriptionEndpoint(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'https:') {
      return true;
    }
    if (
      parsed.protocol === 'http:' &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function validateRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
  options: ValidateRuntimeConfigOptions = {},
): RuntimeConfigValidationResult {
  const errors: ConfigDiagnostic[] = [];
  const warnings: ConfigDiagnostic[] = [];

  const nodeEnv = env.NODE_ENV?.trim() || 'development';
  const isProduction = nodeEnv === 'production';
  const isVercel = env.VERCEL === '1' || Boolean(env.VERCEL_ENV?.trim());
  const dataDir = env.BAJKOKREATOR_DATA_DIR?.trim() || null;

  // 1. AI_PROVIDER
  let aiProvider: ProviderId = DEFAULT_RUNTIME_SETTINGS.activeProvider;
  const rawProvider = env.AI_PROVIDER?.trim();
  if (rawProvider) {
    const parsed = ProviderIdSchema.safeParse(rawProvider);
    if (parsed.success) {
      aiProvider = parsed.data;
    } else {
      errors.push({
        code: 'INVALID_AI_PROVIDER',
        field: 'AI_PROVIDER',
        severity: 'error',
        message: `Nieprawidłowa wartość AI_PROVIDER ("${rawProvider}"). Dozwolone: demo, manual, gemini-api, google-subscription.`,
      });
    }
  }

  // 2. GEMINI_TEXT_MODEL
  let geminiTextModel = DEFAULT_RUNTIME_SETTINGS.textModel;
  const rawTextModel = env.GEMINI_TEXT_MODEL?.trim();
  if (rawTextModel) {
    const parsed = ModelIdSchema.safeParse(rawTextModel);
    if (parsed.success) {
      geminiTextModel = parsed.data;
    } else {
      errors.push({
        code: 'INVALID_GEMINI_TEXT_MODEL',
        field: 'GEMINI_TEXT_MODEL',
        severity: 'error',
        message: 'Nieprawidłowy identyfikator modelu GEMINI_TEXT_MODEL.',
      });
    }
  }

  // 3. GEMINI_IMAGE_MODEL
  let geminiImageModel = DEFAULT_RUNTIME_SETTINGS.imageModel;
  const rawImageModel = env.GEMINI_IMAGE_MODEL?.trim();
  if (rawImageModel) {
    const parsed = ModelIdSchema.safeParse(rawImageModel);
    if (parsed.success) {
      geminiImageModel = parsed.data;
    } else {
      errors.push({
        code: 'INVALID_GEMINI_IMAGE_MODEL',
        field: 'GEMINI_IMAGE_MODEL',
        severity: 'error',
        message: 'Nieprawidłowy identyfikator modelu GEMINI_IMAGE_MODEL.',
      });
    }
  }

  // 4. GEMINI_IMAGE_SIZE
  let geminiImageSize: GeminiImageSize = DEFAULT_GEMINI_IMAGE_SIZE;
  const rawImageSize = env.GEMINI_IMAGE_SIZE?.trim();
  if (rawImageSize) {
    const parsed = GeminiImageSizeSchema.safeParse(rawImageSize);
    if (parsed.success) {
      geminiImageSize = parsed.data;
    } else {
      errors.push({
        code: 'INVALID_GEMINI_IMAGE_SIZE',
        field: 'GEMINI_IMAGE_SIZE',
        severity: 'error',
        message: `Nieprawidłowa wartość GEMINI_IMAGE_SIZE ("${rawImageSize}"). Dozwolone: 1K lub 2K.`,
      });
    }
  }

  // 5. MAX_DAILY_IMAGE_GENERATIONS
  let maxDailyImageGenerations = DEFAULT_DAILY_IMAGE_LIMIT;
  const rawDailyLimit = env.MAX_DAILY_IMAGE_GENERATIONS?.trim();
  if (rawDailyLimit !== undefined && rawDailyLimit.length > 0) {
    const parsedStr = NonNegativeIntStringSchema.safeParse(rawDailyLimit);
    const parsedNum = parsedStr.success ? Number.parseInt(parsedStr.data, 10) : Number.NaN;
    if (parsedStr.success && Number.isSafeInteger(parsedNum) && parsedNum <= 100_000) {
      maxDailyImageGenerations = parsedNum;
    } else {
      errors.push({
        code: 'INVALID_MAX_DAILY_IMAGE_GENERATIONS',
        field: 'MAX_DAILY_IMAGE_GENERATIONS',
        severity: 'error',
        message: `Nieprawidłowa wartość MAX_DAILY_IMAGE_GENERATIONS ("${rawDailyLimit}"). Oczekiwano liczby całkowitej 0..100000.`,
      });
    }
  }

  // 6. DEFAULT_PREVIEW_FIRST
  let defaultPreviewFirst = DEFAULT_RUNTIME_SETTINGS.defaultPreviewFirst;
  const rawPreviewFirst = env.DEFAULT_PREVIEW_FIRST?.trim().toLowerCase();
  if (rawPreviewFirst !== undefined && rawPreviewFirst.length > 0) {
    const parsed = BooleanEnvStringSchema.safeParse(rawPreviewFirst);
    if (parsed.success) {
      defaultPreviewFirst = parsed.data === 'true' || parsed.data === '1';
    } else {
      errors.push({
        code: 'INVALID_DEFAULT_PREVIEW_FIRST',
        field: 'DEFAULT_PREVIEW_FIRST',
        severity: 'error',
        message: `Nieprawidłowa wartość DEFAULT_PREVIEW_FIRST ("${rawPreviewFirst}"). Dozwolone: true, false, 1, 0.`,
      });
    }
  }

  // 7. DEFAULT_BOOK_FORMAT
  let defaultBookFormat: BookFormat = DEFAULT_RUNTIME_SETTINGS.defaultBookFormat;
  const rawBookFormat = env.DEFAULT_BOOK_FORMAT?.trim();
  if (rawBookFormat) {
    const parsed = BookFormatSchema.safeParse(rawBookFormat);
    if (parsed.success) {
      defaultBookFormat = parsed.data;
    } else {
      errors.push({
        code: 'INVALID_DEFAULT_BOOK_FORMAT',
        field: 'DEFAULT_BOOK_FORMAT',
        severity: 'error',
        message: `Nieprawidłowa wartość DEFAULT_BOOK_FORMAT ("${rawBookFormat}"). Dozwolone: square, a4-landscape.`,
      });
    }
  }

  // 8. GOOGLE_AI_AUTH_STRATEGY
  let googleAuthStrategy: AuthStrategy = 'subscription_oauth_stub';
  const rawAuthStrategy = env.GOOGLE_AI_AUTH_STRATEGY?.trim();
  if (rawAuthStrategy) {
    const parsed = AuthStrategySchema.safeParse(rawAuthStrategy);
    if (parsed.success) {
      googleAuthStrategy = parsed.data;
    } else {
      errors.push({
        code: 'INVALID_GOOGLE_AUTH_STRATEGY',
        field: 'GOOGLE_AI_AUTH_STRATEGY',
        severity: 'error',
        message: `Nieprawidłowa wartość GOOGLE_AI_AUTH_STRATEGY ("${rawAuthStrategy}").`,
      });
    }
  }

  // 9. GOOGLE_SUBSCRIPTION_TIER
  let googleSubscriptionTier: 'ai-pro' | 'ai-ultra' = 'ai-pro';
  const rawSubTier = env.GOOGLE_SUBSCRIPTION_TIER?.trim().toLowerCase();
  if (rawSubTier) {
    const parsed = SubscriptionTierSchema.safeParse(rawSubTier);
    if (parsed.success) {
      googleSubscriptionTier = parsed.data;
    } else {
      errors.push({
        code: 'INVALID_GOOGLE_SUBSCRIPTION_TIER',
        field: 'GOOGLE_SUBSCRIPTION_TIER',
        severity: 'error',
        message: `Nieprawidłowa wartość GOOGLE_SUBSCRIPTION_TIER ("${rawSubTier}"). Dozwolone: ai-pro, ai-ultra.`,
      });
    }
  }

  // 10. LOG_LEVEL
  let logLevel: LogLevel = 'info';
  const rawLogLevel = env.LOG_LEVEL?.trim().toLowerCase();
  if (rawLogLevel) {
    const parsed = LogLevelSchema.safeParse(rawLogLevel);
    if (parsed.success) {
      logLevel = parsed.data;
    } else {
      errors.push({
        code: 'INVALID_LOG_LEVEL',
        field: 'LOG_LEVEL',
        severity: 'error',
        message: `Nieprawidłowa wartość LOG_LEVEL ("${rawLogLevel}"). Dozwolone: debug, info, warn, error.`,
      });
    }
  }

  // 11. Retention max age hours
  let retentionMaxAgeHours = DEFAULT_RETENTION_MAX_AGE_HOURS;
  const rawRetentionHours =
    env.BAJKOKREATOR_RETENTION_MAX_AGE_HOURS?.trim() ??
    env.BAJKOKREATOR_RODO_RETENTION_HOURS?.trim();
  if (rawRetentionHours !== undefined && rawRetentionHours.length > 0) {
    const parsedStr = NonNegativeIntStringSchema.safeParse(rawRetentionHours);
    const parsedNum = parsedStr.success ? Number.parseInt(parsedStr.data, 10) : Number.NaN;
    if (parsedStr.success && parsedNum >= 1 && parsedNum <= 87_600) {
      retentionMaxAgeHours = parsedNum;
    } else {
      errors.push({
        code: 'INVALID_RETENTION_MAX_AGE_HOURS',
        field: 'BAJKOKREATOR_RETENTION_MAX_AGE_HOURS',
        severity: 'error',
        message: `Nieprawidłowa wartość BAJKOKREATOR_RETENTION_MAX_AGE_HOURS ("${rawRetentionHours}"). Oczekiwano liczby całkowitej 1..87600.`,
      });
    }
  }

  // Secret presence booleans only (NEVER include secret values in config!)
  const hasGeminiApiKey = Boolean(env.GEMINI_API_KEY?.trim());
  const rawSubscriptionEndpoint = env.GOOGLE_SUBSCRIPTION_ENDPOINT?.trim() ?? '';
  const hasSubscriptionEndpoint = rawSubscriptionEndpoint.length > 0;
  const hasSubscriptionToken = Boolean(env.GOOGLE_SUBSCRIPTION_TOKEN?.trim());
  const hasSubscriptionClientId = Boolean(env.GOOGLE_SUBSCRIPTION_CLIENT_ID?.trim());
  const rawOpsToken = env.BAJKOKREATOR_OPS_TOKEN?.trim() ?? '';
  const hasOpsToken = rawOpsToken.length > 0;
  const requireOpsAuth = env.BAJKOKREATOR_REQUIRE_OPS_AUTH?.trim().toLowerCase() === 'true';
  const allowUnauthenticatedOps =
    env.BAJKOKREATOR_ALLOW_UNAUTHENTICATED_OPS?.trim().toLowerCase() === 'true';
  const rateLimitDisabled =
    env.BAJKOKREATOR_RATE_LIMIT_DISABLED?.trim().toLowerCase() === 'true';

  // Cross-field Errors
  if (aiProvider === 'gemini-api' && !hasGeminiApiKey) {
    errors.push({
      code: 'GEMINI_API_KEY_MISSING',
      field: 'GEMINI_API_KEY',
      severity: 'error',
      message: 'AI_PROVIDER=gemini-api wymaga ustawienia GEMINI_API_KEY.',
    });
  }

  if (aiProvider === 'google-subscription') {
    const missingApiKey = googleAuthStrategy === 'api_key' && !hasGeminiApiKey;
    const missingSubCreds =
      googleAuthStrategy === 'subscription_oauth_stub' &&
      (!hasSubscriptionEndpoint || !hasSubscriptionToken);
    if (missingApiKey || missingSubCreds) {
      errors.push({
        code: 'GOOGLE_SUBSCRIPTION_INCOMPLETE',
        field: 'GOOGLE_SUBSCRIPTION_ENDPOINT',
        severity: 'error',
        message:
          'AI_PROVIDER=google-subscription nie ma kompletnych poświadczeń dla wybranej strategii GOOGLE_AI_AUTH_STRATEGY.',
      });
    }
  }

  if (requireOpsAuth && !hasOpsToken && !allowUnauthenticatedOps) {
    errors.push({
      code: 'OPS_AUTH_LOCKED_OUT',
      field: 'BAJKOKREATOR_OPS_TOKEN',
      severity: 'error',
      message:
        'Ustawiono BAJKOKREATOR_REQUIRE_OPS_AUTH=true bez podania BAJKOKREATOR_OPS_TOKEN — endpointy operatorskie będą odrzucać wszystkie żądania.',
    });
  }

  // Warnings
  if (options.storageMode === 'tmp-fallback' || (isVercel && !dataDir)) {
    warnings.push({
      code: 'EPHEMERAL_TMP_STORAGE',
      field: 'BAJKOKREATOR_DATA_DIR',
      severity: 'warning',
      message:
        'Aplikacja używa ulotnego katalogu /tmp (tmp-fallback). Dane bajek mogą zostać utracone po restarcie kontenera.',
    });
  }

  if (isProduction && !hasOpsToken && !requireOpsAuth) {
    warnings.push({
      code: 'OPS_TOKEN_MISSING_IN_PRODUCTION',
      field: 'BAJKOKREATOR_OPS_TOKEN',
      severity: 'warning',
      message:
        'Brak BAJKOKREATOR_OPS_TOKEN w trybie produkcyjnym — endpointy operatorskie działają w trybie dev-bypass.',
    });
  }

  if (hasOpsToken && rawOpsToken.length < 16) {
    warnings.push({
      code: 'OPS_TOKEN_TOO_SHORT',
      field: 'BAJKOKREATOR_OPS_TOKEN',
      severity: 'warning',
      message: 'Token BAJKOKREATOR_OPS_TOKEN ma mniej niż 16 znaków. Zalecane co najmniej 32 znaki losowe.',
    });
  }

  if (hasSubscriptionEndpoint && !isAllowedSubscriptionEndpoint(rawSubscriptionEndpoint)) {
    warnings.push({
      code: 'SUBSCRIPTION_ENDPOINT_NOT_HTTPS',
      field: 'GOOGLE_SUBSCRIPTION_ENDPOINT',
      severity: 'warning',
      message: 'GOOGLE_SUBSCRIPTION_ENDPOINT powinien używać protokołu https://.',
    });
  }

  if (maxDailyImageGenerations === 0) {
    warnings.push({
      code: 'DAILY_QUOTA_ZERO',
      field: 'MAX_DAILY_IMAGE_GENERATIONS',
      severity: 'warning',
      message: 'MAX_DAILY_IMAGE_GENERATIONS=0 blokuje wszystkie płatne generacje obrazów.',
    });
  }

  return {
    ok: errors.length === 0,
    warnings,
    errors,
    config: {
      nodeEnv,
      isProduction,
      isVercel,
      dataDir,
      aiProvider,
      geminiTextModel,
      geminiImageModel,
      geminiImageSize,
      maxDailyImageGenerations,
      defaultPreviewFirst,
      defaultBookFormat,
      googleAuthStrategy,
      googleSubscriptionTier,
      hasGeminiApiKey,
      hasSubscriptionEndpoint,
      hasSubscriptionToken,
      hasSubscriptionClientId,
      hasOpsToken,
      requireOpsAuth,
      logLevel,
      rateLimitDisabled,
      retentionMaxAgeHours,
    },
  };
}
