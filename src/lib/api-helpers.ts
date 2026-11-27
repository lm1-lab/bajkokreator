import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import sharp from 'sharp';
import { ZodError } from 'zod';
import { resolveGeminiImageSize } from '@/lib/ai/adapters/gemini-api-adapter';
import { AIProviderError } from '@/lib/ai/cost-guard';
import {
  listProviderStatuses,
  type ProviderStatus,
  type ReferencePhotoBinary,
} from '@/lib/ai/provider';
import { resolveSubscriptionConfig } from '@/lib/ai/subscription-adapter';
import { getOperationalLogger } from '@/lib/ops/logger';
import { OrderGuardrailError } from '@/lib/orders/lifecycle';
import { UnauthorizedError } from '@/lib/security/operator-guard';
import { PayloadTooLargeError, RateLimitError } from '@/lib/security/rate-limit';
import { getDailyQuotaStatus, QuotaExceededError } from '@/lib/storage/quota';
import {
  PathSecurityError,
  detectImageMime,
  extensionForMime,
  type AllowedImageMime,
} from '@/lib/storage/security';
import { getRuntimeSettings, getStorageInfo } from '@/lib/storage/store';
import {
  MAX_PHOTO_FILE_BYTES,
  formatZodIssues,
  type DailyQuotaStatus,
  type GeminiImageSize,
  type RuntimeSettings,
  type StorageMode,
} from '@/lib/types/story';

const SAFE_REQUEST_ID_REGEX = /^[A-Za-z0-9._:-]{1,128}$/;

export interface ApiErrorEnvelope {
  error: string;
  code: string;
  requestId: string;
  issues?: unknown;
  quota?: unknown;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export function getOrCreateRequestId(request?: Request): string {
  const incoming = request?.headers.get('x-request-id')?.trim();
  if (incoming && SAFE_REQUEST_ID_REGEX.test(incoming)) {
    return incoming;
  }
  return crypto.randomUUID();
}

export function attachRequestIdHeader(response: NextResponse, requestId: string): NextResponse {
  response.headers.set('X-Request-Id', requestId);
  return response;
}

export function jsonResponse<T>(
  body: T,
  options: {
    status?: number;
    requestId?: string;
    headers?: HeadersInit;
    cacheControl?: string;
  } = {},
): NextResponse {
  const requestId =
    options.requestId && SAFE_REQUEST_ID_REGEX.test(options.requestId)
      ? options.requestId
      : crypto.randomUUID();
  const headers = new Headers(options.headers);
  headers.set('X-Request-Id', requestId);
  if (!headers.has('Cache-Control')) {
    headers.set('Cache-Control', options.cacheControl ?? 'no-store');
  }
  return NextResponse.json(body, {
    status: options.status ?? 200,
    headers,
  });
}

export function errorResponse(options: {
  error: string;
  code: string;
  status: number;
  requestId?: string;
  issues?: unknown;
  quota?: unknown;
  retryable?: boolean;
  details?: Record<string, unknown>;
  headers?: HeadersInit;
}): NextResponse {
  const requestId =
    options.requestId && SAFE_REQUEST_ID_REGEX.test(options.requestId)
      ? options.requestId
      : crypto.randomUUID();

  const payload: ApiErrorEnvelope = {
    error: options.error,
    code: options.code,
    requestId,
    ...(options.issues !== undefined ? { issues: options.issues } : {}),
    ...(options.quota !== undefined ? { quota: options.quota } : {}),
    ...(options.retryable !== undefined ? { retryable: options.retryable } : {}),
    ...(options.details !== undefined ? { details: options.details } : {}),
  };

  const headers = new Headers(options.headers);
  headers.set('X-Request-Id', requestId);
  headers.set('Cache-Control', 'no-store');

  return NextResponse.json(payload, {
    status: options.status,
    headers,
  });
}

export interface MaskedEnvStatus {
  hasGeminiApiKey: boolean;
  geminiTextModel: string;
  geminiImageModel: string;
  geminiImageSize?: GeminiImageSize;
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
    getStorageInfo(),
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
      geminiImageSize: resolveGeminiImageSize(undefined, process.env),
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

function resolveRequestIdParam(requestOrId?: Request | string): string {
  if (typeof requestOrId === 'string' && SAFE_REQUEST_ID_REGEX.test(requestOrId)) {
    return requestOrId;
  }
  if (requestOrId instanceof Request) {
    return getOrCreateRequestId(requestOrId);
  }
  return crypto.randomUUID();
}

function resolveOrderGuardrailHttpStatus(err: OrderGuardrailError): number {
  const maybeStatus = (err as { httpStatus?: unknown }).httpStatus;
  if (typeof maybeStatus === 'number' && maybeStatus >= 400 && maybeStatus <= 599) {
    return maybeStatus;
  }

  const code = String(err.code);
  if (
    code === 'AGENT_FORBIDDEN_ACTION' ||
    code === 'AGENT_REFUND_LIMIT_EXCEEDED' ||
    code === 'FORBIDDEN_ACTOR'
  ) {
    return 403;
  }
  if (
    code === 'SHIPPING_ADDRESS_REQUIRED' ||
    code === 'PAYMENT_REFERENCE_REQUIRED' ||
    code === 'VALIDATION_ERROR'
  ) {
    return 422;
  }
  return 409;
}

export function handleApiError(
  err: unknown,
  requestOrId?: Request | string,
): NextResponse {
  const requestId = resolveRequestIdParam(requestOrId);

  if (err instanceof ZodError) {
    return errorResponse({
      error: 'Nieprawidłowe dane wejściowe.',
      code: 'VALIDATION_ERROR',
      status: 400,
      requestId,
      issues: formatZodIssues(err),
    });
  }

  if (err instanceof UnauthorizedError) {
    const headers: Record<string, string> = {};
    if (err.httpStatus === 401) {
      headers['WWW-Authenticate'] = 'Bearer realm="bajkokreator-ops"';
    }
    return errorResponse({
      error: err.message,
      code: err.code,
      status: err.httpStatus,
      requestId,
      headers,
    });
  }

  if (err instanceof RateLimitError) {
    return errorResponse({
      error: err.message,
      code: err.code,
      status: err.httpStatus,
      requestId,
      retryable: true,
      details: {
        limit: err.limit,
        remaining: err.remaining,
        resetAtIso: err.resetAtIso,
        retryAfterSeconds: err.retryAfterSeconds,
      },
      headers: {
        'Retry-After': String(err.retryAfterSeconds),
        'X-RateLimit-Limit': String(err.limit),
        'X-RateLimit-Remaining': String(err.remaining),
        'X-RateLimit-Reset': err.resetAtIso,
      },
    });
  }

  if (err instanceof PayloadTooLargeError) {
    return errorResponse({
      error: err.message,
      code: err.code,
      status: err.httpStatus,
      requestId,
      details: {
        maxBytes: err.maxBytes,
      },
    });
  }

  if (err instanceof OrderGuardrailError) {
    return errorResponse({
      error: err.message,
      code: err.code,
      status: resolveOrderGuardrailHttpStatus(err),
      requestId,
    });
  }

  if (err instanceof PathSecurityError) {
    return errorResponse({
      error: err.message,
      code: err.code,
      status: err.httpStatus,
      requestId,
    });
  }

  if (err instanceof QuotaExceededError) {
    return errorResponse({
      error: err.message,
      code: err.code,
      status: err.httpStatus,
      requestId,
      quota: err.status,
      retryable: false,
    });
  }

  if (err instanceof AIProviderError) {
    return errorResponse({
      error: err.message,
      code: err.code,
      status: err.httpStatus,
      requestId,
      retryable: err.retryable,
    });
  }

  if (err instanceof SyntaxError) {
    return errorResponse({
      error: 'Nieprawidłowy format JSON w treści żądania.',
      code: 'INVALID_JSON',
      status: 400,
      requestId,
    });
  }

  getOperationalLogger().error(
    'api',
    'unhandled_error',
    { error: err },
    requestId,
  );
  return errorResponse({
    error: 'Wystąpił wewnętrzny błąd serwera. Spróbuj ponownie.',
    code: 'INTERNAL_ERROR',
    status: 500,
    requestId,
  });
}
