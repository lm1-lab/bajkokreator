import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getOrCreateRequestId,
  handleApiError,
  jsonResponse,
} from '@/lib/api-helpers';
import { requireOperatorAuth } from '@/lib/security/operator-guard';
import {
  ROUTE_RATE_LIMITS,
  enforceRateLimit,
  parseJsonBodyWithLimit,
} from '@/lib/security/rate-limit';
import { evaluateSupportPolicy } from '@/lib/support/guardrails';
import { searchKnowledgeBaseWithScores } from '@/lib/support/knowledge-base';
import {
  TicketStatusSchema,
  createSanitizedSupportTicket,
  getSupportTicketRepository,
} from '@/lib/support/tickets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CreateInquiryBodySchema = z.object({
  customerEmail: z.email('Podaj prawidłowy adres e-mail.'),
  orderNumber: z.string().trim().min(3).max(80).optional(),
  subject: z.string().trim().min(2, 'Podaj temat zgłoszenia.').max(200),
  message: z.string().trim().min(5, 'Opisz swoje pytanie lub zgłoszenie.').max(4000),
});

export async function GET(request: Request): Promise<NextResponse> {
  const requestId = getOrCreateRequestId(request);
  try {
    await requireOperatorAuth(request, ['admin', 'agent', 'ops-readonly']);
    const url = new URL(request.url);
    const rawStatus = url.searchParams.get('status')?.trim();
    const status = rawStatus ? TicketStatusSchema.parse(rawStatus) : undefined;
    const tickets = await getSupportTicketRepository().listTickets(
      status ? { status } : undefined,
    );
    return jsonResponse({ tickets }, { status: 200, requestId });
  } catch (err) {
    return handleApiError(err, requestId);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const requestId = getOrCreateRequestId(request);
  try {
    await enforceRateLimit(request, ROUTE_RATE_LIMITS.supportInquiries);
    const rawBody = await parseJsonBodyWithLimit(request, 64 * 1024);
    const body = CreateInquiryBodySchema.parse(rawBody);

    const kbMatches = searchKnowledgeBaseWithScores({
      q: `${body.subject} ${body.message}`,
      limit: 3,
    });

    const escalation = evaluateSupportPolicy({
      subject: body.subject,
      message: body.message,
      kbMatches,
    });

    const ticket = createSanitizedSupportTicket({
      customerEmail: body.customerEmail,
      ...(body.orderNumber ? { orderNumber: body.orderNumber } : {}),
      subject: body.subject,
      message: body.message,
      shouldEscalate: escalation.shouldEscalate,
      escalationReasons: escalation.reasons,
      priority: escalation.priority,
      suggestedArticleIds: kbMatches.map((m) => m.article.id),
    });

    const saved = await getSupportTicketRepository().saveTicket(ticket);

    return jsonResponse(
      {
        ticket: saved,
        escalation: {
          shouldEscalate: escalation.shouldEscalate,
          reasons: escalation.reasons,
          priority: escalation.priority,
        },
        suggestedArticles: kbMatches.map((m) => m.article),
      },
      { status: 201, requestId },
    );
  } catch (err) {
    return handleApiError(err, requestId);
  }
}
