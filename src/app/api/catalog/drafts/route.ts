import { NextResponse } from 'next/server';
import {
  errorResponse,
  getOrCreateRequestId,
  handleApiError,
  jsonResponse,
} from '@/lib/api-helpers';
import {
  buildThemePromotionReport,
  getThemeDraftRepository,
  type ThemeDraftRecord,
} from '@/lib/catalog/draft-repository';
import { validateThemeProposal } from '@/lib/catalog/validator';
import { requireOperatorAuth } from '@/lib/security/operator-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const requestId = getOrCreateRequestId(request);
  try {
    await requireOperatorAuth(request, ['admin', 'agent', 'ops-readonly']);
    const drafts = await getThemeDraftRepository().listDrafts();
    return jsonResponse({ drafts }, { status: 200, requestId });
  } catch (err) {
    return handleApiError(err, requestId);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const requestId = getOrCreateRequestId(request);
  try {
    const identity = await requireOperatorAuth(request, ['admin', 'agent']);
    const rawBody: unknown = await request.json();
    if (!rawBody || typeof rawBody !== 'object') {
      return errorResponse({
        error: 'Wymagany jest obiekt JSON z propozycją motywu (pole theme).',
        code: 'VALIDATION_ERROR',
        status: 400,
        requestId,
      });
    }

    const body = rawBody as Record<string, unknown>;
    const candidate = 'theme' in body && typeof body.theme === 'object' ? body.theme : body;
    const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 1000) : undefined;

    const validation = await validateThemeProposal(candidate, {
      runDryRunPreflight: true,
    });

    if (!validation.valid || !validation.theme) {
      return errorResponse({
        error: 'Propozycja motywu nie przeszła walidacji redakcyjnej.',
        code: 'INVALID_THEME_DRAFT',
        status: 422,
        requestId,
        details: {
          errors: validation.errors,
          warnings: validation.warnings,
        },
      });
    }

    const nowIso = new Date().toISOString();
    const repo = getThemeDraftRepository();
    const existing = await repo.getDraft(validation.theme.id);

    const record: ThemeDraftRecord = {
      id: validation.theme.id,
      status: 'review',
      createdBy: identity.id,
      ...(notes ? { notes } : {}),
      theme: {
        ...validation.theme,
        tags: [...validation.theme.tags],
        lifecycleStatus: 'draft',
      },
      ...(validation.dryRunPreflight
        ? {
            dryRunPreflight: {
              readyForPrint: validation.dryRunPreflight.readyForPrint,
              score: validation.dryRunPreflight.score,
            },
          }
        : {}),
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
    };

    const saved = await repo.saveDraft(record);
    const promotionReport = buildThemePromotionReport(saved);

    return jsonResponse(
      {
        draft: saved,
        promotionReport,
        warnings: validation.warnings,
      },
      { status: existing ? 200 : 201, requestId },
    );
  } catch (err) {
    return handleApiError(err, requestId);
  }
}
