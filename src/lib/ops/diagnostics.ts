import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ZodError } from 'zod';
import { AIProviderError } from '@/lib/ai/cost-guard';
import { getMetricsSink } from '@/lib/ops/event-bus';
import { getOperationalLogger, redactPii } from '@/lib/ops/logger';
import { getStorageRoot } from '@/lib/storage/paths';
import { QuotaExceededError } from '@/lib/storage/quota';
import { PathSecurityError, resolveSafeChildPath } from '@/lib/storage/security';
import type { GenerationMode, ProviderId } from '@/lib/types/story';

// =============================================================================
// Rotating PII-Safe Generation Failure Diagnostics Store
// Persists generation failures under <rootDir>/ops/diagnostics.jsonl so ops
// supervision & agents can inspect failures even when partial story dirs are
// rolled back.
// =============================================================================

export type DiagnosticOperation = 'story.create' | 'story.continue';
export type DiagnosticStage =
  | 'validation'
  | 'quota'
  | 'blueprint'
  | 'cover'
  | 'page'
  | 'persistence'
  | 'unknown';

export interface GenerationDiagnosticRecord {
  id: string;
  timestamp: string;
  requestId?: string;
  operation: DiagnosticOperation;
  storyId?: string;
  provider?: ProviderId;
  generationMode?: GenerationMode;
  stage: DiagnosticStage;
  failedSlot?: 'cover' | number;
  completedSlots?: Array<'cover' | number>;
  errorCode: string;
  errorMessage: string;
  httpStatus?: number;
  retryable?: boolean;
  durationMs?: number;
}

export interface RecordGenerationFailureInput {
  requestId?: string;
  operation: DiagnosticOperation;
  storyId?: string;
  provider?: ProviderId;
  generationMode?: GenerationMode;
  stage: DiagnosticStage;
  failedSlot?: 'cover' | number;
  completedSlots?: Array<'cover' | number>;
  errorCode: string;
  errorMessage: string;
  httpStatus?: number;
  retryable?: boolean;
  durationMs?: number;
  timestamp?: string;
}

export interface DiagnosticErrorInfo {
  errorCode: string;
  errorMessage: string;
  httpStatus?: number;
  retryable?: boolean;
}

export function extractDiagnosticErrorInfo(err: unknown): DiagnosticErrorInfo {
  if (err instanceof AIProviderError) {
    return {
      errorCode: err.code,
      errorMessage: redactPii(err.message).slice(0, 500),
      httpStatus: err.httpStatus,
      retryable: err.retryable,
    };
  }
  if (err instanceof QuotaExceededError) {
    return {
      errorCode: err.code,
      errorMessage: redactPii(err.message).slice(0, 500),
      httpStatus: err.httpStatus,
      retryable: false,
    };
  }
  if (err instanceof PathSecurityError) {
    return {
      errorCode: err.code,
      errorMessage: redactPii(err.message).slice(0, 500),
      httpStatus: err.httpStatus,
      retryable: false,
    };
  }
  if (err instanceof ZodError) {
    return {
      errorCode: 'VALIDATION_ERROR',
      errorMessage: redactPii(
        err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') ||
          'Validation failed',
      ).slice(0, 500),
      httpStatus: 400,
      retryable: false,
    };
  }
  if (err instanceof Error) {
    const maybeCode = (err as { code?: unknown }).code;
    const maybeHttpStatus = (err as { httpStatus?: unknown }).httpStatus;
    return {
      errorCode: typeof maybeCode === 'string' && maybeCode.trim() ? maybeCode : err.name || 'ERROR',
      errorMessage: redactPii(err.message || err.name || 'Unknown error').slice(0, 500),
      ...(typeof maybeHttpStatus === 'number' ? { httpStatus: maybeHttpStatus } : {}),
    };
  }
  return {
    errorCode: 'UNKNOWN_ERROR',
    errorMessage: redactPii(String(err)).slice(0, 500),
  };
}

export interface DiagnosticsStoreOptions {
  maxBytes?: number;
  maxArchives?: number;
  resolveFilePath?: () => Promise<string>;
}

function getErrnoCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

async function defaultResolveDiagnosticsPath(): Promise<string> {
  const { rootDir } = await getStorageRoot();
  return resolveSafeChildPath(rootDir, 'ops', 'diagnostics.jsonl');
}

export class JsonlDiagnosticsStore {
  private readonly maxBytes: number;
  private readonly maxArchives: number;
  private readonly resolveFilePath: () => Promise<string>;
  private writeLock: Promise<void> = Promise.resolve();

  constructor(options: DiagnosticsStoreOptions = {}) {
    this.maxBytes = Math.max(256, options.maxBytes ?? 2 * 1024 * 1024);
    this.maxArchives = Math.max(0, options.maxArchives ?? 3);
    this.resolveFilePath = options.resolveFilePath ?? defaultResolveDiagnosticsPath;
  }

  private async withWriteLock<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.writeLock;
    let release!: () => void;
    this.writeLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
    }
  }

  private async rotateIfNeeded(filePath: string, incomingBytes: number): Promise<void> {
    let currentSize = 0;
    try {
      const stat = await fs.stat(filePath);
      currentSize = stat.size;
    } catch (err) {
      if (getErrnoCode(err) === 'ENOENT') {
        return;
      }
      throw err;
    }

    if (currentSize + incomingBytes <= this.maxBytes) {
      return;
    }

    if (this.maxArchives === 0) {
      await fs.unlink(filePath).catch(() => undefined);
      return;
    }

    await fs.unlink(`${filePath}.${this.maxArchives}`).catch(() => undefined);
    for (let i = this.maxArchives - 1; i >= 1; i -= 1) {
      await fs.rename(`${filePath}.${i}`, `${filePath}.${i + 1}`).catch(() => undefined);
    }
    await fs.rename(filePath, `${filePath}.1`).catch(() => undefined);
  }

  async append(input: RecordGenerationFailureInput): Promise<GenerationDiagnosticRecord | null> {
    const record: GenerationDiagnosticRecord = {
      id: crypto.randomUUID(),
      timestamp: input.timestamp ?? new Date().toISOString(),
      ...(input.requestId ? { requestId: input.requestId } : {}),
      operation: input.operation,
      ...(input.storyId ? { storyId: input.storyId } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.generationMode ? { generationMode: input.generationMode } : {}),
      stage: input.stage,
      ...(input.failedSlot !== undefined ? { failedSlot: input.failedSlot } : {}),
      ...(input.completedSlots && input.completedSlots.length > 0
        ? { completedSlots: [...input.completedSlots] }
        : {}),
      errorCode: redactPii(input.errorCode).slice(0, 120) || 'UNKNOWN_ERROR',
      errorMessage: redactPii(input.errorMessage).slice(0, 500),
      ...(input.httpStatus !== undefined ? { httpStatus: input.httpStatus } : {}),
      ...(input.retryable !== undefined ? { retryable: input.retryable } : {}),
      ...(input.durationMs !== undefined && Number.isFinite(input.durationMs)
        ? { durationMs: Math.max(0, Math.round(input.durationMs)) }
        : {}),
    };

    try {
      const line = `${JSON.stringify(record)}\n`;
      const incomingBytes = Buffer.byteLength(line, 'utf8');
      await this.withWriteLock(async () => {
        const filePath = await this.resolveFilePath();
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await this.rotateIfNeeded(filePath, incomingBytes);
        await fs.appendFile(filePath, line, 'utf8');
      });
    } catch (err) {
      getOperationalLogger().warn('diagnostics', 'diagnostics_write_failed', {
        operation: input.operation,
        stage: input.stage,
        error: err,
      });
      return null;
    }

    getMetricsSink().increment('generation.failures', 1, {
      operation: record.operation,
      provider: record.provider ?? 'unknown',
      stage: record.stage,
      code: record.errorCode,
    });

    return record;
  }

  async listRecent(
    limit = 50,
    sinceHours?: number,
    nowMs = Date.now(),
  ): Promise<GenerationDiagnosticRecord[]> {
    const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
    const cutoffMs =
      sinceHours !== undefined && Number.isFinite(sinceHours) && sinceHours > 0
        ? nowMs - sinceHours * 3_600_000
        : null;

    try {
      const filePath = await this.resolveFilePath();
      const raw = await fs.readFile(filePath, 'utf8');
      const records: GenerationDiagnosticRecord[] = [];
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as GenerationDiagnosticRecord;
          if (!parsed || typeof parsed.timestamp !== 'string' || typeof parsed.errorCode !== 'string') {
            continue;
          }
          if (cutoffMs !== null) {
            const ts = Date.parse(parsed.timestamp);
            if (Number.isNaN(ts) || ts < cutoffMs) {
              continue;
            }
          }
          records.push(parsed);
        } catch {
          // Skip malformed lines cleanly
        }
      }
      return records
        .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
        .slice(0, safeLimit);
    } catch (err) {
      if (getErrnoCode(err) === 'ENOENT') {
        return [];
      }
      return [];
    }
  }
}

const defaultDiagnosticsStore = new JsonlDiagnosticsStore();

export async function recordGenerationFailure(
  input: RecordGenerationFailureInput,
): Promise<GenerationDiagnosticRecord | null> {
  return defaultDiagnosticsStore.append(input);
}

export async function listRecentDiagnostics(
  limit = 50,
  sinceHours?: number,
  nowMs?: number,
): Promise<GenerationDiagnosticRecord[]> {
  return defaultDiagnosticsStore.listRecent(limit, sinceHours, nowMs);
}

export interface DiagnosticsSummary {
  total: number;
  byCode: Record<string, number>;
  byProvider: Record<string, number>;
  byOperation: Record<string, number>;
}

export function summarizeDiagnostics(
  records: readonly GenerationDiagnosticRecord[],
): DiagnosticsSummary {
  const byCode: Record<string, number> = {};
  const byProvider: Record<string, number> = {};
  const byOperation: Record<string, number> = {};

  for (const r of records) {
    byCode[r.errorCode] = (byCode[r.errorCode] ?? 0) + 1;
    const providerKey = r.provider ?? 'unknown';
    byProvider[providerKey] = (byProvider[providerKey] ?? 0) + 1;
    byOperation[r.operation] = (byOperation[r.operation] ?? 0) + 1;
  }

  return {
    total: records.length,
    byCode,
    byProvider,
    byOperation,
  };
}
