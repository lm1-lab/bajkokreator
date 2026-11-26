import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { StorageMode } from '@/lib/types/story';

export type { StorageMode };

export interface StorageRootInfo {
  rootDir: string;
  mode: StorageMode;
}

const READONLY_ERRNO_CODES = new Set(['EROFS', 'EACCES', 'EPERM']);

let cachedRoot: { key: string; info: StorageRootInfo } | null = null;

function getErrnoCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function isReadOnlyError(err: unknown): boolean {
  const code = getErrnoCode(err);
  return code !== undefined && READONLY_ERRNO_CODES.has(code);
}

function computeCacheKey(): string {
  return JSON.stringify([
    process.env.BAJKOKREATOR_DATA_DIR?.trim() ?? '',
    process.env.VERCEL ?? '',
    process.env.VERCEL_ENV ?? '',
    process.cwd(),
    os.tmpdir(),
  ]);
}

async function probeWritableDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const probePath = path.join(dir, `.write-probe-${process.pid}-${crypto.randomUUID()}`);
  try {
    await fs.writeFile(probePath, 'ok', { flag: 'wx' });
  } finally {
    await fs.unlink(probePath).catch(() => {});
  }
}

async function resolveTmpFallback(): Promise<StorageRootInfo> {
  const tmpFallbackDir = path.join(os.tmpdir(), 'bajkokreator-data');
  await fs.mkdir(tmpFallbackDir, { recursive: true });
  return { rootDir: tmpFallbackDir, mode: 'tmp-fallback' };
}

export function resetStorageRootCache(): void {
  cachedRoot = null;
}

export async function getStorageRoot(): Promise<StorageRootInfo> {
  const cacheKey = computeCacheKey();

  if (cachedRoot && cachedRoot.key === cacheKey) {
    try {
      await fs.mkdir(cachedRoot.info.rootDir, { recursive: true });
      if (cachedRoot.info.mode === 'local') {
        await fs.access(cachedRoot.info.rootDir, fsConstants.W_OK);
      }
      return cachedRoot.info;
    } catch (err) {
      if (!isReadOnlyError(err)) {
        throw err;
      }
      cachedRoot = null;
    }
  }

  const rawCustomDir = process.env.BAJKOKREATOR_DATA_DIR?.trim();
  let info: StorageRootInfo;

  if (rawCustomDir) {
    const customDir = path.resolve(rawCustomDir);
    try {
      await probeWritableDir(customDir);
      info = { rootDir: customDir, mode: 'local' };
    } catch (err) {
      if (isReadOnlyError(err)) {
        info = await resolveTmpFallback();
      } else {
        throw err;
      }
    }
  } else if (process.env.VERCEL === '1' || Boolean(process.env.VERCEL_ENV?.trim())) {
    info = await resolveTmpFallback();
  } else {
    const localDir = path.resolve(process.cwd(), 'data');
    try {
      await probeWritableDir(localDir);
      info = { rootDir: localDir, mode: 'local' };
    } catch (err) {
      if (isReadOnlyError(err)) {
        info = await resolveTmpFallback();
      } else {
        throw err;
      }
    }
  }

  cachedRoot = { key: cacheKey, info };
  return info;
}

export async function writeFileAtomic(
  targetPath: string,
  content: string | Buffer,
): Promise<void> {
  const parentDir = path.dirname(targetPath);
  await fs.mkdir(parentDir, { recursive: true });
  const tmpPath = `${targetPath}.tmp.${process.pid}.${crypto.randomUUID()}`;
  try {
    await fs.writeFile(tmpPath, content);
    await fs.rename(tmpPath, targetPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}
