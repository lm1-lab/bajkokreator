import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { z } from 'zod';
import { getStorageRoot, writeFileAtomic } from '@/lib/storage/paths';
import { resolveSafeChildPath } from '@/lib/storage/security';

// =============================================================================
// Vendor-Agnostic IdempotencyStore Port & Atomic Filesystem Implementation
// =============================================================================

export const IdempotencyRecordSchema = z.object({
  key: z.string().min(1).max(200),
  scope: z.string().min(1).max(80),
  payloadDigest: z.string().length(64),
  resourceId: z.string().min(1).max(160),
  statusCode: z.number().int().min(200).max(599),
  createdAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
});

export type IdempotencyRecord = z.infer<typeof IdempotencyRecordSchema>;

export interface IdempotencyStore {
  readonly kind: string;
  get(scope: string, key: string): Promise<IdempotencyRecord | null>;
  save(record: IdempotencyRecord): Promise<void>;
}

function getErrnoCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export function computePayloadDigest(payload: unknown): string {
  return crypto.createHash('sha256').update(stableStringify(payload), 'utf8').digest('hex');
}

function hashIdempotencySlot(scope: string, key: string): string {
  return crypto.createHash('sha256').update(`${scope}:${key}`, 'utf8').digest('hex');
}

export class FilesystemIdempotencyStore implements IdempotencyStore {
  readonly kind = 'filesystem';

  private async resolvePath(scope: string, key: string): Promise<string> {
    const { rootDir } = await getStorageRoot();
    const hash = hashIdempotencySlot(scope, key);
    return resolveSafeChildPath(rootDir, 'ops', 'idempotency', `${hash}.json`);
  }

  async get(scope: string, key: string): Promise<IdempotencyRecord | null> {
    const filePath = await this.resolvePath(scope, key);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      if (getErrnoCode(err) === 'ENOENT') {
        return null;
      }
      throw err;
    }

    try {
      const parsed = IdempotencyRecordSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return null;
      if (parsed.data.expiresAt && Date.parse(parsed.data.expiresAt) < Date.now()) {
        return null;
      }
      return parsed.data;
    } catch {
      return null;
    }
  }

  async save(record: IdempotencyRecord): Promise<void> {
    const validated = IdempotencyRecordSchema.parse(record);
    const filePath = await this.resolvePath(validated.scope, validated.key);
    await writeFileAtomic(filePath, `${JSON.stringify(validated, null, 2)}\n`);
  }
}

const defaultIdempotencyStore: IdempotencyStore = new FilesystemIdempotencyStore();
let activeIdempotencyStore: IdempotencyStore = defaultIdempotencyStore;

export function getIdempotencyStore(): IdempotencyStore {
  return activeIdempotencyStore;
}

export function setIdempotencyStore(store: IdempotencyStore): void {
  activeIdempotencyStore = store;
}

export function resetIdempotencyStore(): void {
  activeIdempotencyStore = defaultIdempotencyStore;
}
