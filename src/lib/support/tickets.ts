import crypto from 'node:crypto';
import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import { z } from 'zod';
import { getStorageRoot, writeFileAtomic } from '@/lib/storage/paths';
import { PathSecurityError, resolveSafeChildPath } from '@/lib/storage/security';
import {
  maskEmailForTicket,
  redactSupportPii,
  type EscalationReason,
  type SupportPriority,
} from './guardrails';

// =============================================================================
// Vendor-Agnostic SupportTicketRepository Port & PII-Safe Filesystem Adapter
// =============================================================================

export const TICKET_ID_REGEX = /^tkt-[a-z0-9][a-z0-9_-]{3,58}$/;
export const TICKET_STATUSES = [
  'open',
  'escalated_to_human',
  'waiting_customer',
  'resolved',
  'closed',
] as const;

export const TicketStatusSchema = z.enum(TICKET_STATUSES);
export type TicketStatus = z.infer<typeof TicketStatusSchema>;

export const SupportTicketRecordSchema = z.object({
  id: z.string().regex(TICKET_ID_REGEX),
  status: TicketStatusSchema,
  priority: z.enum(['normal', 'high', 'urgent']),
  customerEmailMasked: z.string().trim().min(3).max(160),
  customerEmailHash: z.string().length(64),
  orderNumber: z.string().trim().min(3).max(80).optional(),
  subject: z.string().trim().min(2).max(200),
  messageRedacted: z.string().trim().min(3).max(4000),
  shouldEscalate: z.boolean(),
  escalationReasons: z.array(z.string().min(1)).default([]),
  suggestedArticleIds: z.array(z.string().min(1)).default([]),
  operatorNotes: z.string().trim().max(2000).optional(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});

export type SupportTicketRecord = z.infer<typeof SupportTicketRecordSchema>;

export interface SupportTicketRepository {
  readonly kind: string;
  saveTicket(ticket: SupportTicketRecord): Promise<SupportTicketRecord>;
  getTicket(id: string): Promise<SupportTicketRecord | null>;
  listTickets(filter?: { status?: TicketStatus }): Promise<SupportTicketRecord[]>;
}

function getErrnoCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

export function assertValidTicketId(rawId: string): string {
  const trimmed = rawId.trim();
  if (!TICKET_ID_REGEX.test(trimmed)) {
    throw new PathSecurityError('Nieprawidłowy identyfikator zgłoszenia.', 'INVALID_TICKET_ID');
  }
  return trimmed;
}

export function generateSupportTicketId(): string {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex');
  return `tkt-${ts}-${rand}`;
}

export function createSanitizedSupportTicket(params: {
  customerEmail: string;
  orderNumber?: string;
  subject: string;
  message: string;
  shouldEscalate: boolean;
  escalationReasons: readonly EscalationReason[];
  priority: SupportPriority;
  suggestedArticleIds: readonly string[];
  now?: Date;
}): SupportTicketRecord {
  const nowIso = (params.now ?? new Date()).toISOString();
  const normalizedEmail = params.customerEmail.trim().toLowerCase();
  const customerEmailHash = crypto
    .createHash('sha256')
    .update(`bajkokreator-support-email-v1:${normalizedEmail}`)
    .digest('hex');

  return SupportTicketRecordSchema.parse({
    id: generateSupportTicketId(),
    status: params.shouldEscalate ? 'escalated_to_human' : 'open',
    priority: params.priority,
    customerEmailMasked: maskEmailForTicket(normalizedEmail),
    customerEmailHash,
    ...(params.orderNumber ? { orderNumber: params.orderNumber.trim().toUpperCase() } : {}),
    subject: redactSupportPii(params.subject.trim()),
    messageRedacted: redactSupportPii(params.message.trim()),
    shouldEscalate: params.shouldEscalate,
    escalationReasons: [...params.escalationReasons],
    suggestedArticleIds: [...params.suggestedArticleIds],
    createdAt: nowIso,
    updatedAt: nowIso,
  });
}

export class FilesystemSupportTicketRepository implements SupportTicketRepository {
  readonly kind = 'filesystem';

  private async getTicketPath(id: string): Promise<string> {
    const safeId = assertValidTicketId(id);
    const { rootDir } = await getStorageRoot();
    return resolveSafeChildPath(rootDir, 'support', 'tickets', `${safeId}.json`);
  }

  async saveTicket(ticket: SupportTicketRecord): Promise<SupportTicketRecord> {
    const validated = SupportTicketRecordSchema.parse(ticket);
    const filePath = await this.getTicketPath(validated.id);
    await writeFileAtomic(filePath, `${JSON.stringify(validated, null, 2)}\n`);
    return validated;
  }

  async getTicket(id: string): Promise<SupportTicketRecord | null> {
    const safeId = assertValidTicketId(id);
    const filePath = await this.getTicketPath(safeId);
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
      const parsed = SupportTicketRecordSchema.safeParse(JSON.parse(raw));
      return parsed.success && parsed.data.id === safeId ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async listTickets(filter?: { status?: TicketStatus }): Promise<SupportTicketRecord[]> {
    const { rootDir } = await getStorageRoot();
    const dir = resolveSafeChildPath(rootDir, 'support', 'tickets');
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (getErrnoCode(err) === 'ENOENT') {
        return [];
      }
      throw err;
    }

    const tickets: SupportTicketRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const id = entry.name.slice(0, -5);
      if (!TICKET_ID_REGEX.test(id)) continue;
      const ticket = await this.getTicket(id);
      if (!ticket) continue;
      if (filter?.status && ticket.status !== filter.status) continue;
      tickets.push(ticket);
    }

    tickets.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return tickets;
  }
}

const defaultSupportTicketRepo: SupportTicketRepository =
  new FilesystemSupportTicketRepository();
let activeSupportTicketRepo: SupportTicketRepository = defaultSupportTicketRepo;

export function getSupportTicketRepository(): SupportTicketRepository {
  return activeSupportTicketRepo;
}

export function setSupportTicketRepository(repo: SupportTicketRepository): void {
  activeSupportTicketRepo = repo;
}

export function resetSupportTicketRepository(): void {
  activeSupportTicketRepo = defaultSupportTicketRepo;
}
