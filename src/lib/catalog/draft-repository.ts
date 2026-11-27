import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import { z } from 'zod';
import { getStorageRoot, writeFileAtomic } from '@/lib/storage/paths';
import { PathSecurityError, resolveSafeChildPath } from '@/lib/storage/security';
import {
  ThemeCatalogItemSchema,
  type ThemeCatalogItem,
} from './themes';

// =============================================================================
// Non-Destructive Seasonal Theme Draft Staging Repository
// Staged drafts live strictly under `<rootDir>/catalog/drafts/<id>.json` and
// NEVER mutate `src/content/themes.json` directly (human PR / promotion gate).
// =============================================================================

export const DRAFT_ID_REGEX = /^[a-z0-9][a-z0-9-]{1,63}$/;

export const ThemeDraftRecordSchema = z.object({
  id: z.string().regex(DRAFT_ID_REGEX),
  status: z.enum(['draft', 'review', 'approved_for_pr', 'rejected']).default('draft'),
  createdBy: z.string().trim().min(1).max(120),
  notes: z.string().trim().max(1000).optional(),
  theme: ThemeCatalogItemSchema,
  dryRunPreflight: z
    .object({
      readyForPrint: z.boolean(),
      score: z.number().int().min(0).max(100),
    })
    .optional(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});

export type ThemeDraftRecord = z.infer<typeof ThemeDraftRecordSchema>;

export interface ThemeDraftRepository {
  readonly kind: string;
  saveDraft(draft: ThemeDraftRecord): Promise<ThemeDraftRecord>;
  getDraft(id: string): Promise<ThemeDraftRecord | null>;
  listDrafts(): Promise<ThemeDraftRecord[]>;
  deleteDraft(id: string): Promise<boolean>;
}

function getErrnoCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function assertValidDraftId(rawId: string): string {
  const trimmed = rawId.trim();
  if (!DRAFT_ID_REGEX.test(trimmed)) {
    throw new PathSecurityError('Nieprawidłowy identyfikator szkicu motywu.', 'INVALID_DRAFT_ID');
  }
  return trimmed;
}

export class FilesystemThemeDraftRepository implements ThemeDraftRepository {
  readonly kind = 'filesystem';

  private async getDraftPath(id: string): Promise<string> {
    const safeId = assertValidDraftId(id);
    const { rootDir } = await getStorageRoot();
    return resolveSafeChildPath(rootDir, 'catalog', 'drafts', `${safeId}.json`);
  }

  async saveDraft(draft: ThemeDraftRecord): Promise<ThemeDraftRecord> {
    const validated = ThemeDraftRecordSchema.parse(draft);
    const filePath = await this.getDraftPath(validated.id);
    await writeFileAtomic(filePath, `${JSON.stringify(validated, null, 2)}\n`);
    return validated;
  }

  async getDraft(id: string): Promise<ThemeDraftRecord | null> {
    const safeId = assertValidDraftId(id);
    const filePath = await this.getDraftPath(safeId);
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
      const parsed = ThemeDraftRecordSchema.safeParse(JSON.parse(raw));
      return parsed.success && parsed.data.id === safeId ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async listDrafts(): Promise<ThemeDraftRecord[]> {
    const { rootDir } = await getStorageRoot();
    const draftsDir = resolveSafeChildPath(rootDir, 'catalog', 'drafts');
    let entries: Dirent[];
    try {
      entries = await fs.readdir(draftsDir, { withFileTypes: true });
    } catch (err) {
      if (getErrnoCode(err) === 'ENOENT') {
        return [];
      }
      throw err;
    }

    const drafts: ThemeDraftRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const id = entry.name.slice(0, -5);
      if (!DRAFT_ID_REGEX.test(id)) continue;
      const draft = await this.getDraft(id);
      if (draft) drafts.push(draft);
    }

    drafts.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return drafts;
  }

  async deleteDraft(id: string): Promise<boolean> {
    const safeId = assertValidDraftId(id);
    const filePath = await this.getDraftPath(safeId);
    try {
      await fs.unlink(filePath);
      return true;
    } catch (err) {
      if (getErrnoCode(err) === 'ENOENT') {
        return false;
      }
      throw err;
    }
  }
}

export function buildThemePromotionReport(draft: ThemeDraftRecord): {
  targetFile: string;
  draftId: string;
  prTitle: string;
  jsonEntry: ThemeCatalogItem;
} {
  return {
    targetFile: 'src/content/themes.json',
    draftId: draft.id,
    prTitle: `feat(catalog): add seasonal theme "${draft.theme.label}" (${draft.theme.id})`,
    jsonEntry: {
      ...draft.theme,
      lifecycleStatus: 'active',
    },
  };
}

const defaultThemeDraftRepo: ThemeDraftRepository = new FilesystemThemeDraftRepository();
let activeThemeDraftRepo: ThemeDraftRepository = defaultThemeDraftRepo;

export function getThemeDraftRepository(): ThemeDraftRepository {
  return activeThemeDraftRepo;
}

export function setThemeDraftRepository(repo: ThemeDraftRepository): void {
  activeThemeDraftRepo = repo;
}

export function resetThemeDraftRepository(): void {
  activeThemeDraftRepo = defaultThemeDraftRepo;
}
