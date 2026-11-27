import fs from 'node:fs/promises';
import path from 'node:path';
import { getOperationalLogger, redactPiiValue } from '@/lib/ops/logger';
import type {
  DomainEvent,
  DomainEventBus,
  DomainEventHandler,
} from '@/lib/orders/ports';
import { getStorageRoot } from '@/lib/storage/paths';
import { resolveSafeChildPath } from '@/lib/storage/security';

export type { DomainEvent, DomainEventBus, DomainEventHandler };
export type DomainEventType = DomainEvent['type'];

// =============================================================================
// MetricsSink Port & In-Memory Implementation
// =============================================================================

export type MetricTags = Record<string, string | number | boolean>;

export interface TimingAggregate {
  count: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
}

export interface MetricsSnapshot {
  counters: Record<string, number>;
  timings: Record<string, TimingAggregate>;
}

export interface MetricsSink {
  increment(name: string, value?: number, tags?: MetricTags): void;
  timing(name: string, durationMs: number, tags?: MetricTags): void;
  getSnapshot(): MetricsSnapshot;
  reset(): void;
}

const MAX_METRIC_KEYS = 2_000;

function formatMetricKey(name: string, tags?: MetricTags): string {
  if (!tags) {
    return name;
  }
  const entries = Object.entries(tags).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    return name;
  }
  const serialized = entries.map(([k, v]) => `${k}=${String(v)}`).join(',');
  return `${name}{${serialized}}`;
}

export class InMemoryMetricsSink implements MetricsSink {
  private readonly counters = new Map<string, number>();
  private readonly timings = new Map<
    string,
    { count: number; totalMs: number; minMs: number; maxMs: number }
  >();

  increment(name: string, value = 1, tags?: MetricTags): void {
    if (!Number.isFinite(value)) {
      return;
    }
    const key = formatMetricKey(name, tags);
    if (!this.counters.has(key) && this.counters.size >= MAX_METRIC_KEYS) {
      return;
    }
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  timing(name: string, durationMs: number, tags?: MetricTags): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      return;
    }
    const key = formatMetricKey(name, tags);
    const existing = this.timings.get(key);
    if (!existing) {
      if (this.timings.size >= MAX_METRIC_KEYS) {
        return;
      }
      this.timings.set(key, {
        count: 1,
        totalMs: durationMs,
        minMs: durationMs,
        maxMs: durationMs,
      });
      return;
    }
    existing.count += 1;
    existing.totalMs += durationMs;
    if (durationMs < existing.minMs) existing.minMs = durationMs;
    if (durationMs > existing.maxMs) existing.maxMs = durationMs;
  }

  getSnapshot(): MetricsSnapshot {
    const counters: Record<string, number> = {};
    for (const [k, v] of this.counters.entries()) {
      counters[k] = v;
    }

    const timings: Record<string, TimingAggregate> = {};
    for (const [k, v] of this.timings.entries()) {
      timings[k] = {
        count: v.count,
        totalMs: Number(v.totalMs.toFixed(2)),
        minMs: Number(v.minMs.toFixed(2)),
        maxMs: Number(v.maxMs.toFixed(2)),
        avgMs: Number((v.totalMs / v.count).toFixed(2)),
      };
    }

    return { counters, timings };
  }

  reset(): void {
    this.counters.clear();
    this.timings.clear();
  }
}

const defaultMetricsSink: MetricsSink = new InMemoryMetricsSink();
let activeMetricsSink: MetricsSink = defaultMetricsSink;

export function getMetricsSink(): MetricsSink {
  return activeMetricsSink;
}

export function setMetricsSink(sink: MetricsSink): void {
  activeMetricsSink = sink;
}

export function resetMetricsSink(): void {
  defaultMetricsSink.reset();
  activeMetricsSink = defaultMetricsSink;
}

// =============================================================================
// PII-Safe Domain Event Projection & Rotating JSONL Event Sink
// =============================================================================

export interface PersistedDomainEventRecord {
  recordedAt: string;
  type: DomainEventType;
  occurredAt: string;
  payload: Record<string, unknown>;
}

/**
 * Projects a DomainEvent to an explicit PII-safe allowlist payload (never
 * persisting customer email, shipping address, or raw text content).
 */
export function sanitizeDomainEventForSink(event: DomainEvent): PersistedDomainEventRecord {
  let rawPayload: Record<string, unknown>;

  switch (event.type) {
    case 'story.created':
      rawPayload = {
        storyId: event.storyId,
        provider: event.provider,
        pageCount: event.pageCount,
      };
      break;
    case 'story.reference_photos_purged':
      rawPayload = {
        storyId: event.storyId,
        deletedCount: event.deletedCount,
      };
      break;
    case 'story.preflight_completed':
      rawPayload = {
        storyId: event.storyId,
        readyForPrint: event.report.readyForPrint,
        score: event.report.score,
        errors: event.report.summary.errors,
        warnings: event.report.summary.warnings,
      };
      break;
    case 'order.status_changed':
      rawPayload = {
        orderId: event.orderId,
        storyId: event.storyId,
        from: event.from,
        to: event.to,
        paymentStatus: event.order.paymentStatus,
        currency: event.order.currency,
        totalMinorUnits: event.order.totalMinorUnits,
      };
      break;
  }

  return {
    recordedAt: new Date().toISOString(),
    type: event.type,
    occurredAt: event.occurredAt,
    payload: redactPiiValue(rawPayload) as Record<string, unknown>,
  };
}

export interface JsonlEventSinkOptions {
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

async function defaultResolveEventsPath(): Promise<string> {
  const { rootDir } = await getStorageRoot();
  return resolveSafeChildPath(rootDir, 'ops', 'events.jsonl');
}

export class JsonlEventSink {
  private readonly maxBytes: number;
  private readonly maxArchives: number;
  private readonly resolveFilePath: () => Promise<string>;
  private writeLock: Promise<void> = Promise.resolve();

  constructor(options: JsonlEventSinkOptions = {}) {
    this.maxBytes = Math.max(256, options.maxBytes ?? 2 * 1024 * 1024);
    this.maxArchives = Math.max(0, options.maxArchives ?? 3);
    this.resolveFilePath = options.resolveFilePath ?? defaultResolveEventsPath;
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

  async handle(event: DomainEvent): Promise<void> {
    try {
      const record = sanitizeDomainEventForSink(event);
      const line = `${JSON.stringify(record)}\n`;
      const incomingBytes = Buffer.byteLength(line, 'utf8');

      await this.withWriteLock(async () => {
        const filePath = await this.resolveFilePath();
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await this.rotateIfNeeded(filePath, incomingBytes);
        await fs.appendFile(filePath, line, 'utf8');
      });
    } catch (err) {
      getOperationalLogger().warn('event-bus', 'jsonl_sink_write_failed', {
        eventType: event.type,
        error: err,
      });
    }
  }

  async readRecent(limit = 50): Promise<PersistedDomainEventRecord[]> {
    const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
    try {
      const filePath = await this.resolveFilePath();
      const raw = await fs.readFile(filePath, 'utf8');
      const lines = raw.split('\n');
      const records: PersistedDomainEventRecord[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as PersistedDomainEventRecord;
          if (parsed && typeof parsed.type === 'string' && typeof parsed.occurredAt === 'string') {
            records.push(parsed);
          }
        } catch {
          // Skip malformed lines cleanly
        }
      }
      return records.slice(-safeLimit).reverse();
    } catch (err) {
      if (getErrnoCode(err) === 'ENOENT') {
        return [];
      }
      return [];
    }
  }
}

// =============================================================================
// In-Process DomainEventBus & Registry
// =============================================================================

export class InMemoryDomainEventBus implements DomainEventBus {
  private readonly handlers = new Set<DomainEventHandler>();
  private readonly onHandlerError: (err: unknown, event: DomainEvent) => void;

  constructor(options?: { onHandlerError?: (err: unknown, event: DomainEvent) => void }) {
    this.onHandlerError =
      options?.onHandlerError ??
      ((err, event) => {
        getOperationalLogger().warn('event-bus', 'subscriber_failed', {
          eventType: event.type,
          error: err,
        });
      });
  }

  subscribe(handler: DomainEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async publish(event: DomainEvent): Promise<void> {
    const snapshot = Array.from(this.handlers);
    const results = await Promise.allSettled(
      snapshot.map((handler) => Promise.resolve().then(() => handler(event))),
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        this.onHandlerError(result.reason, event);
      }
    }
  }
}

let defaultEventSink = new JsonlEventSink();

export function createDefaultDomainEventBus(
  options?: JsonlEventSinkOptions,
): InMemoryDomainEventBus {
  const bus = new InMemoryDomainEventBus();
  const sink = options ? new JsonlEventSink(options) : defaultEventSink;

  bus.subscribe((event) => sink.handle(event));
  bus.subscribe((event) => {
    const metrics = getMetricsSink();
    metrics.increment('domain_events.published', 1, { type: event.type });
    if (event.type === 'story.created') {
      metrics.increment('stories.created', 1, { provider: event.provider });
    } else if (event.type === 'story.reference_photos_purged') {
      metrics.increment('rodo.reference_photos_purged', 1);
      if (event.deletedCount > 0) {
        metrics.increment('rodo.reference_photos_deleted_files', event.deletedCount);
      }
    }
  });

  return bus;
}

let activeEventBus: DomainEventBus = createDefaultDomainEventBus();

export function getDomainEventBus(): DomainEventBus {
  return activeEventBus;
}

export function setDomainEventBus(bus: DomainEventBus): void {
  activeEventBus = bus;
}

export function resetDomainEventBus(): void {
  defaultEventSink = new JsonlEventSink();
  activeEventBus = createDefaultDomainEventBus();
}

export async function readRecentDomainEvents(
  limit = 50,
): Promise<PersistedDomainEventRecord[]> {
  return defaultEventSink.readRecent(limit);
}
