import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import { getStorageRoot, writeFileAtomic } from '@/lib/storage/paths';
import { PathSecurityError, resolveSafeChildPath } from '@/lib/storage/security';
import {
  ORDER_ID_REGEX,
  ORDER_NUMBER_REGEX,
  OrderGuardrailError,
  OrderRecordSchema,
  isOrderLockingReferencePhotos,
  type OrderRecord,
  type OrderStatus,
} from './lifecycle';

// =============================================================================
// Vendor-Agnostic OrderRepository Port & Atomic Filesystem Implementation
// Swap in Postgres / Drizzle / Prisma via `setOrderRepository()` without
// modifying any route handlers or domain services.
// =============================================================================

export interface OrderListFilter {
  storyId?: string;
  status?: OrderStatus;
}

export interface OrderRepository {
  readonly kind: string;
  createOrder(order: OrderRecord): Promise<OrderRecord>;
  saveOrder(order: OrderRecord, expectedVersion?: number): Promise<OrderRecord>;
  getOrder(id: string): Promise<OrderRecord | null>;
  getOrderByNumber(orderNumber: string): Promise<OrderRecord | null>;
  findByIdempotencyKey(idempotencyKey: string): Promise<OrderRecord | null>;
  listOrders(filter?: OrderListFilter): Promise<OrderRecord[]>;
}

function getErrnoCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

export function assertValidOrderId(rawId: string): string {
  const trimmed = rawId.trim();
  if (!ORDER_ID_REGEX.test(trimmed)) {
    throw new PathSecurityError('Nieprawidłowy identyfikator zamówienia.', 'INVALID_ORDER_ID');
  }
  return trimmed;
}

const orderLocks = new Map<string, Promise<void>>();

export async function withOrderLock<T>(orderId: string, fn: () => Promise<T>): Promise<T> {
  const prev = orderLocks.get(orderId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prev.catch(() => undefined).then(() => current);
  orderLocks.set(orderId, tail);

  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (orderLocks.get(orderId) === tail) {
      orderLocks.delete(orderId);
    }
  }
}

export class FilesystemOrderRepository implements OrderRepository {
  readonly kind = 'filesystem';

  private async getOrderFilePath(orderId: string): Promise<string> {
    const safeId = assertValidOrderId(orderId);
    const { rootDir } = await getStorageRoot();
    return resolveSafeChildPath(rootDir, 'orders', safeId, 'order.json');
  }

  async createOrder(order: OrderRecord): Promise<OrderRecord> {
    const validated = OrderRecordSchema.parse(order);
    return withOrderLock(validated.id, async () => {
      const filePath = await this.getOrderFilePath(validated.id);
      try {
        await fs.access(filePath);
        throw new OrderGuardrailError(
          `Zamówienie o identyfikatorze ${validated.id} już istnieje.`,
          'VERSION_CONFLICT',
          409,
        );
      } catch (err) {
        if (err instanceof OrderGuardrailError) {
          throw err;
        }
        if (getErrnoCode(err) !== 'ENOENT') {
          throw err;
        }
      }

      await writeFileAtomic(filePath, `${JSON.stringify(validated, null, 2)}\n`);
      return validated;
    });
  }

  async saveOrder(order: OrderRecord, expectedVersion?: number): Promise<OrderRecord> {
    const validated = OrderRecordSchema.parse(order);
    return withOrderLock(validated.id, async () => {
      const filePath = await this.getOrderFilePath(validated.id);
      if (expectedVersion !== undefined) {
        const existing = await this.readOrderFileUnchecked(filePath, validated.id);
        if (!existing) {
          throw new OrderGuardrailError(
            `Zamówienie ${validated.id} nie istnieje.`,
            'VERSION_CONFLICT',
            409,
          );
        }
        if (existing.version !== expectedVersion) {
          throw new OrderGuardrailError(
            `Konflikt wersji zamówienia (oczekiwano v${expectedVersion}, zapisana v${existing.version}).`,
            'VERSION_CONFLICT',
            409,
          );
        }
      }

      await writeFileAtomic(filePath, `${JSON.stringify(validated, null, 2)}\n`);
      return validated;
    });
  }

  private async readOrderFileUnchecked(
    filePath: string,
    expectedId: string,
  ): Promise<OrderRecord | null> {
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
      const parsed: unknown = JSON.parse(raw);
      const validated = OrderRecordSchema.safeParse(parsed);
      if (!validated.success || validated.data.id !== expectedId) {
        return null;
      }
      return validated.data;
    } catch {
      return null;
    }
  }

  async getOrder(id: string): Promise<OrderRecord | null> {
    const safeId = assertValidOrderId(id);
    const filePath = await this.getOrderFilePath(safeId);
    return this.readOrderFileUnchecked(filePath, safeId);
  }

  async getOrderByNumber(orderNumber: string): Promise<OrderRecord | null> {
    const normalized = orderNumber.trim().toUpperCase();
    if (!ORDER_NUMBER_REGEX.test(normalized)) {
      return null;
    }
    const all = await this.listOrders();
    return all.find((order) => order.orderNumber === normalized) ?? null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<OrderRecord | null> {
    const trimmed = idempotencyKey.trim();
    if (!trimmed) {
      return null;
    }
    const all = await this.listOrders();
    return all.find((order) => order.idempotencyKey === trimmed) ?? null;
  }

  async listOrders(filter?: OrderListFilter): Promise<OrderRecord[]> {
    const { rootDir } = await getStorageRoot();
    const ordersDir = resolveSafeChildPath(rootDir, 'orders');

    let entries: Dirent[];
    try {
      entries = await fs.readdir(ordersDir, { withFileTypes: true });
    } catch (err) {
      if (getErrnoCode(err) === 'ENOENT') {
        return [];
      }
      throw err;
    }

    const orders: OrderRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !ORDER_ID_REGEX.test(entry.name)) {
        continue;
      }
      try {
        const order = await this.getOrder(entry.name);
        if (!order) continue;
        if (filter?.storyId && order.storyId !== filter.storyId) continue;
        if (filter?.status && order.status !== filter.status) continue;
        orders.push(order);
      } catch {
        continue;
      }
    }

    orders.sort((a, b) => {
      const diff = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
      if (diff !== 0) return diff;
      return b.id.localeCompare(a.id);
    });

    return orders;
  }
}

const defaultOrderRepository: OrderRepository = new FilesystemOrderRepository();
let activeOrderRepository: OrderRepository = defaultOrderRepository;

export function getOrderRepository(): OrderRepository {
  return activeOrderRepository;
}

export function setOrderRepository(repository: OrderRepository): void {
  activeOrderRepository = repository;
}

export function resetOrderRepository(): void {
  activeOrderRepository = defaultOrderRepository;
}

export async function getOrderByIdOrNumber(idOrNumber: string): Promise<OrderRecord | null> {
  const trimmed = idOrNumber.trim();
  if (ORDER_NUMBER_REGEX.test(trimmed.toUpperCase())) {
    return getOrderRepository().getOrderByNumber(trimmed.toUpperCase());
  }
  if (ORDER_ID_REGEX.test(trimmed)) {
    return getOrderRepository().getOrder(trimmed);
  }
  return null;
}

export async function hasActiveOrderLockingStory(storyId: string): Promise<boolean> {
  const orders = await getOrderRepository().listOrders({ storyId });
  return orders.some((order) => isOrderLockingReferencePhotos(order));
}

export async function computeLiveOrderMetrics(): Promise<{
  available: boolean;
  total: number;
  byStatus: Partial<Record<string, number>>;
  awaitingApproval: number;
  preflightFailed: number;
  readyForPrintSubmission: number;
}> {
  const orders = await getOrderRepository().listOrders();
  const byStatus: Partial<Record<string, number>> = {};
  let awaitingApproval = 0;
  let preflightFailed = 0;
  let readyForPrintSubmission = 0;

  for (const order of orders) {
    byStatus[order.status] = (byStatus[order.status] ?? 0) + 1;
    if (order.status === 'paid' || order.status === 'awaiting_customer_approval') {
      awaitingApproval += 1;
    } else if (order.status === 'preflight_failed') {
      preflightFailed += 1;
    } else if (order.status === 'preflight_passed') {
      readyForPrintSubmission += 1;
    }
  }

  return {
    available: true,
    total: orders.length,
    byStatus,
    awaitingApproval,
    preflightFailed,
    readyForPrintSubmission,
  };
}
