import { NextResponse } from 'next/server';
import sharp from 'sharp';
import { ZodError } from 'zod';
import { AIProviderError } from '@/lib/ai/cost-guard';
import {
  listProviderStatuses,
  type ProviderStatus,
  type ReferencePhotoBinary,
} from '@/lib/ai/provider';
import { resolveSubscriptionConfig } from '@/lib/ai/subscription-adapter';
import { getStorageRoot } from '@/lib/storage/paths';
import { getDailyQuotaStatus, QuotaExceededError } from '@/lib/storage/quota';
import {
  PathSecurityError,
  detectImageMime,
  extensionForMime,
  type AllowedImageMime,
} from '@/lib/storage/security';
import { getRuntimeSettings } from '@/lib/storage/store';
import {
  MAX_PHOTO_FILE_BYTES,
  formatZodIssues,
  type DailyQuotaStatus,
  type RuntimeSettings,
  type StorageMode,
} from '@/lib/types/story';

export interface MaskedEnvStatus {
  hasGeminiApiKey: boolean;
  geminiTextModel: string;
  geminiImageModel: string;
  maxDailyImageGenerations: number;
  googleAuthStrategy: 'api_key' | 'subscription_oauth_stub';
  hasSubscriptionEndpoint: boolean;
  hasSubscriptionToken: boolean;
  hasSubscriptionClientId: boolean;
  subscriptionTier: 'ai-pro' | 'ai-ultra';
  subscriptionPlannedDate: string;
  subscriptionReadyReason: string;
  subscriptionRequiredEnvVars: ReadonlyArray<string>;
}

export interface SettingsSnapshot {
  settings: RuntimeSettings;
  quota: DailyQuotaStatus;
  storageMode: StorageMode;
  providers: ProviderStatus[];
  envStatus: MaskedEnvStatus;
}

export async function buildSettingsSnapshot(): Promise<SettingsSnapshot> {
  const [settings, quota, storageInfo] = await Promise.all([
    getRuntimeSettings(),
    getDailyQuotaStatus(),
    getStorageRoot(),
  ]);
  const providers = listProviderStatuses();
  const subCfg = resolveSubscriptionConfig();

  return {
    settings,
    quota,
    storageMode: storageInfo.mode,
    providers,
    envStatus: {
      hasGeminiApiKey: Boolean(process.env.GEMINI_API_KEY?.trim()),
      geminiTextModel: process.env.GEMINI_TEXT_MODEL?.trim() || 'gemini-3.8-flash',
      geminiImageModel:
        process.env.GEMINI_IMAGE_MODEL?.trim() || 'gemini-nano-banana-2.1',
      maxDailyImageGenerations: quota.limit,
      googleAuthStrategy: subCfg.authStrategy,
      hasSubscriptionEndpoint: Boolean(subCfg.endpoint),
      hasSubscriptionToken: Boolean(subCfg.token),
      hasSubscriptionClientId: Boolean(subCfg.clientId),
      subscriptionTier: subCfg.tier,
      subscriptionPlannedDate: subCfg.plannedLaunchDate,
      subscriptionReadyReason: subCfg.readyReason,
      subscriptionRequiredEnvVars: subCfg.requiredEnvVars,
    },
  };
}

export interface ValidatedUploadedImage {
  buffer: Buffer;
  mimeType: AllowedImageMime;
  ext: 'jpg' | 'png' | 'webp';
  originalName: string;
}

export async function validateUploadedImageFile(
  file: File,
  maxBytes = MAX_PHOTO_FILE_BYTES,
): Promise<ValidatedUploadedImage> {
  if (file.size <= 0) {
    throw new PathSecurityError('Przesłany plik obrazu jest pusty.', 'EMPTY_ASSET');
  }
  if (file.size > maxBytes) {
    throw new PathSecurityError(
      `Plik przekracza maksymalny dozwolony rozmiar (${Math.round(maxBytes / (1024 * 1024))} MB).`,
      'ASSET_TOO_LARGE',
    );
  }

  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.length === 0) {
    throw new PathSecurityError('Przesłany plik obrazu jest pusty.', 'EMPTY_ASSET');
  }
  if (buffer.length > maxBytes) {
    throw new PathSecurityError(
      `Plik przekracza maksymalny dozwolony rozmiar (${Math.round(maxBytes / (1024 * 1024))} MB).`,
      'ASSET_TOO_LARGE',
    );
  }

  const mimeType = detectImageMime(buffer);
  if (!mimeType) {
    throw new PathSecurityError(
      'Nieprawidłowy format obrazu. Dozwolone są wyłącznie prawdziwe pliki JPEG, PNG lub WebP.',
      'INVALID_IMAGE_MIME',
    );
  }

  // Decode metadata with sharp to catch truncated/corrupted payloads cleanly (400 instead of 500)
  try {
    const meta = await sharp(buffer).metadata();
    if (!meta.width || !meta.height || meta.width <= 0 || meta.height <= 0) {
      throw new Error('Missing dimensions');
    }
    // Verify at least partial pixel decode succeeds so corrupt JPEGs fail validation early
    await sharp(buffer).resize(16, 16, { fit: 'inside' }).raw().toBuffer();
  } catch {
    throw new PathSecurityError(
      'Plik obrazu jest uszkodzony i nie może zostać odczytany.',
      'CORRUPTED_IMAGE',
    );
  }

  return {
    buffer,
    mimeType,
    ext: extensionForMime(mimeType),
    originalName: file.name || `image.${extensionForMime(mimeType)}`,
  };
}

export function toReferencePhotoBinary(
  filename: string,
  mimeType: AllowedImageMime,
  buffer: Buffer,
): ReferencePhotoBinary {
  return { filename, mimeType, buffer };
}

export function handleApiError(err: unknown): NextResponse {
  if (err instanceof ZodError) {
    return NextResponse.json(
      {
        error: 'Nieprawidłowe dane wejściowe.',
        code: 'VALIDATION_ERROR',
        issues: formatZodIssues(err),
      },
      { status: 400 },
    );
  }

  if (err instanceof PathSecurityError) {
    return NextResponse.json(
      {
        error: err.message,
        code: err.code,
      },
      { status: err.httpStatus },
    );
  }

  if (err instanceof QuotaExceededError) {
    return NextResponse.json(
      {
        error: err.message,
        code: err.code,
        quota: err.status,
      },
      { status: err.httpStatus },
    );
  }

  if (err instanceof AIProviderError) {
    return NextResponse.json(
      {
        error: err.message,
        code: err.code,
        retryable: err.retryable,
      },
      { status: err.httpStatus },
    );
  }

  if (err instanceof SyntaxError) {
    return NextResponse.json(
      {
        error: 'Nieprawidłowy format JSON w treści żądania.',
        code: 'INVALID_JSON',
      },
      { status: 400 },
    );
  }

  console.error('[BajkoKreator API error]', err);
  return NextResponse.json(
    {
      error: 'Wystąpił wewnętrzny błąd serwera. Spróbuj ponownie.',
      code: 'INTERNAL_ERROR',
    },
    { status: 500 },
  );
}
