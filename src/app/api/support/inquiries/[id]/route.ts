import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  errorResponse,
  getOrCreateRequestId,
  handleApiError,
  jsonResponse,
} from '@/lib/api-helpers';
import { requireOperatorAuth } from '@/lib/security/operator-guard';
import { redactSupportPii } from '@/lib/support/guardrails';
import {
  TicketStatusSchema,
  getSupportTicketRepository,
} from '@/lib/support/tickets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const PatchTicketBodySchema = z
  .object({
    status: TicketStatusSchema.optional(),
    operatorNotes: z.string().trim().max(2000).optional(),
  })
  .refine((val) => val.status !== undefined || val.operatorNotes !== undefined, {
    message: 'Podaj status lub notatkę operatora do aktualizacji.',
  });

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  const requestId = getOrCreateRequestId(request);
  try {
    await requireOperatorAuth(request, ['admin', 'agent', 'ops-readonly']);
    const { id } = await context.params;
    const ticket = await getSupportTicketRepository().getTicket(id);
    if (!ticket) {
      return errorResponse({
        error: 'Nie znaleziono zgłoszenia o podanym identyfikatorze.',
        code: 'NOT_FOUND',
        status: 404,
        requestId,
      });
    }
    return jsonResponse({ ticket }, { status: 200, requestId });
  } catch (err) {
    return handleApiError(err, requestId);
  }
}

export async function PATCH(
  request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  const requestId = getOrCreateRequestId(request);
  try {
    await requireOperatorAuth(request, ['admin', 'agent']);
    const { id } = await context.params;
    const repo = getSupportTicketRepository();
    const existing = await repo.getTicket(id);
    if (!existing) {
      return errorResponse({
        error: 'Nie znaleziono zgłoszenia o podanym identyfikatorze.',
        code: 'NOT_FOUND',
        status: 404,
        requestId,
      });
    }

    const rawBody: unknown = await request.json();
    const body = PatchTicketBodySchema.parse(rawBody);
    const updated = await repo.saveTicket({
      ...existing,
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.operatorNotes !== undefined
        ? { operatorNotes: redactSupportPii(body.operatorNotes) }
        : {}),
      updatedAt: new Date().toISOString(),
    });

    return jsonResponse({ ticket: updated }, { status: 200, requestId });
  } catch (err) {
    return handleApiError(err, requestId);
  }
}
