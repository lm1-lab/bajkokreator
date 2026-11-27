// =============================================================================
// Vendor-Agnostic RateLimiter Port, In-Memory Sliding Window & Body Size Guards
// Swap in Redis / Upstash / Cloudflare Durable Objects via `setRateLimiter()`.
// =============================================================================

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAtIso: string;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  check(
    bucket: string,
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitResult>;
}

export class RateLimitError extends Error {
  readonly httpStatus = 429;
  readonly code = 'RATE_LIMIT_EXCEEDED';
  readonly retryAfterSeconds: number;
  readonly limit: number;
  readonly remaining: number;
  readonly resetAtIso: string;
  readonly bucket: string;

  constructor(result: RateLimitResult, bucket: string) {
    super(
      `Zbyt wiele żądań w krótkim czasie. Spróbuj ponownie za ${result.retryAfterSeconds} s.`,
    );
    this.name = 'RateLimitError';
    this.retryAfterSeconds = result.retryAfterSeconds;
    this.limit = result.limit;
    this.remaining = result.remaining;
    this.resetAtIso = result.resetAtIso;
    this.bucket = bucket;
    Object.setPrototypeOf(this, RateLimitError.prototype);
  }
}

export class PayloadTooLargeError extends Error {
  readonly httpStatus = 413;
  readonly code = 'PAYLOAD_TOO_LARGE';
  readonly maxBytes: number;

  constructor(maxBytes: number, message?: string) {
    super(
      message ??
        `Rozmiar treści żądania przekracza maksymalny dozwolony limit (${maxBytes} B).`,
    );
    this.name = 'PayloadTooLargeError';
    this.maxBytes = maxBytes;
    Object.setPrototypeOf(this, PayloadTooLargeError.prototype);
  }
}

interface HitBucket {
  timestamps: number[];
  expiresAt: number;
}

export class InMemoryRateLimiter implements RateLimiter {
  private readonly now: () => number;
  private readonly maxKeys: number;
  private readonly pruneIntervalMs: number;
  private readonly hits = new Map<string, HitBucket>();
  private lastPrunedAt: number;

  constructor(options?: {
    now?: () => number;
    maxKeys?: number;
    pruneIntervalMs?: number;
  }) {
    this.now = options?.now ?? (() => Date.now());
    this.maxKeys = Math.max(1, options?.maxKeys ?? 10_000);
    this.pruneIntervalMs = Math.max(1_000, options?.pruneIntervalMs ?? 60_000);
    this.lastPrunedAt = this.now();
  }

  private prune(nowMs: number): void {
    for (const [key, entry] of this.hits.entries()) {
      if (entry.expiresAt <= nowMs) {
        this.hits.delete(key);
      }
    }
    while (this.hits.size >= this.maxKeys) {
      const oldestKey = this.hits.keys().next().value;
      if (oldestKey === undefined) break;
      this.hits.delete(oldestKey);
    }
    this.lastPrunedAt = nowMs;
  }

  async check(
    bucket: string,
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitResult> {
    const safeLimit = Math.max(1, Math.floor(limit));
    const safeWindowSec = Math.max(1, Math.floor(windowSeconds));
    const windowMs = safeWindowSec * 1000;
    const nowMs = this.now();
    const cutoff = nowMs - windowMs;

    if (nowMs - this.lastPrunedAt >= this.pruneIntervalMs || this.hits.size >= this.maxKeys) {
      this.prune(nowMs);
    }

    const compositeKey = `${bucket}:${key}`;
    const existing = this.hits.get(compositeKey);
    const activeTimestamps = existing
      ? existing.timestamps.filter((ts) => ts > cutoff)
      : [];

    if (activeTimestamps.length >= safeLimit) {
      const resetAtMs = activeTimestamps[0] + windowMs;
      const retryAfterSeconds = Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000));
      this.hits.delete(compositeKey);
      this.hits.set(compositeKey, {
        timestamps: activeTimestamps,
        expiresAt: activeTimestamps[activeTimestamps.length - 1] + windowMs,
      });
      return {
        allowed: false,
        limit: safeLimit,
        remaining: 0,
        resetAtIso: new Date(resetAtMs).toISOString(),
        retryAfterSeconds,
      };
    }

    activeTimestamps.push(nowMs);
    const resetAtMs = activeTimestamps[0] + windowMs;
    this.hits.delete(compositeKey);
    this.hits.set(compositeKey, {
      timestamps: activeTimestamps,
      expiresAt: nowMs + windowMs,
    });

    return {
      allowed: true,
      limit: safeLimit,
      remaining: Math.max(0, safeLimit - activeTimestamps.length),
      resetAtIso: new Date(resetAtMs).toISOString(),
      retryAfterSeconds: 0,
    };
  }

  clear(): void {
    this.hits.clear();
  }
}

let activeLimiter: RateLimiter = new InMemoryRateLimiter();

export function getRateLimiter(): RateLimiter {
  return activeLimiter;
}

export function setRateLimiter(limiter: RateLimiter): void {
  activeLimiter = limiter;
}

export function resetRateLimiter(): void {
  activeLimiter = new InMemoryRateLimiter();
}

const SAFE_CLIENT_KEY_REGEX = /^[A-Za-z0-9.:_-]{1,64}$/;

export function getClientKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const candidates = [
    forwarded ? forwarded.split(',')[0]?.trim() : undefined,
    request.headers.get('x-real-ip')?.trim(),
    request.headers.get('cf-connecting-ip')?.trim(),
  ];

  for (const candidate of candidates) {
    if (candidate && SAFE_CLIENT_KEY_REGEX.test(candidate)) {
      return candidate;
    }
  }
  return 'local-client';
}

export interface RouteRateLimitPolicy {
  readonly bucket: string;
  readonly limit: number;
  readonly windowSeconds: number;
}

/**
 * Generous defaults (>= 60 req/min) so sequential E2E specs on localhost never
 * collide with rate limits while burst abuse still receives deterministic 429s.
 */
export const ROUTE_RATE_LIMITS = {
  storiesCreate: { bucket: 'stories:create', limit: 60, windowSeconds: 60 },
  storiesContinue: { bucket: 'stories:continue', limit: 60, windowSeconds: 60 },
  illustrationsUpload: { bucket: 'stories:illustrations', limit: 120, windowSeconds: 60 },
  settingsPatch: { bucket: 'settings:patch', limit: 60, windowSeconds: 60 },
  opsRetentionSweep: { bucket: 'ops:retention-sweep', limit: 60, windowSeconds: 60 },
  opsSummary: { bucket: 'ops:summary', limit: 60, windowSeconds: 60 },
} as const satisfies Record<string, RouteRateLimitPolicy>;

export async function enforceRateLimit(
  request: Request,
  policy: RouteRateLimitPolicy,
  customKey?: string,
): Promise<RateLimitResult> {
  if (process.env.BAJKOKREATOR_RATE_LIMIT_DISABLED?.trim().toLowerCase() === 'true') {
    return {
      allowed: true,
      limit: policy.limit,
      remaining: policy.limit,
      resetAtIso: new Date(Date.now() + policy.windowSeconds * 1000).toISOString(),
      retryAfterSeconds: 0,
    };
  }

  const key = customKey ?? getClientKey(request);
  const result = await getRateLimiter().check(
    policy.bucket,
    key,
    policy.limit,
    policy.windowSeconds,
  );
  if (!result.allowed) {
    throw new RateLimitError(result, policy.bucket);
  }
  return result;
}

export function assertContentLengthLimit(request: Request, maxBytes: number): void {
  const raw = request.headers.get('content-length')?.trim();
  if (!raw || !/^\d+$/.test(raw)) {
    return;
  }
  const declared = Number.parseInt(raw, 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new PayloadTooLargeError(maxBytes);
  }
}

export async function parseJsonBodyWithLimit<T = unknown>(
  request: Request,
  maxBytes = 256 * 1024,
): Promise<T> {
  assertContentLengthLimit(request, maxBytes);
  const rawText = await request.text();
  if (Buffer.byteLength(rawText, 'utf8') > maxBytes) {
    throw new PayloadTooLargeError(maxBytes);
  }
  return JSON.parse(rawText) as T;
}

export async function parseOptionalJsonBodyWithLimit<T = unknown>(
  request: Request,
  maxBytes = 64 * 1024,
): Promise<T | undefined> {
  assertContentLengthLimit(request, maxBytes);
  const rawText = await request.text();
  if (Buffer.byteLength(rawText, 'utf8') > maxBytes) {
    throw new PayloadTooLargeError(maxBytes);
  }
  if (rawText.trim().length === 0) {
    return undefined;
  }
  return JSON.parse(rawText) as T;
}
