import { NextResponse } from 'next/server';
import {
  errorResponse,
  getOrCreateRequestId,
  handleApiError,
  jsonResponse,
} from '@/lib/api-helpers';
import { validateThemeProposal } from '@/lib/catalog/validator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const requestId = getOrCreateRequestId(request);
  try {
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
    const allowExistingId = body.allowExistingId === true;
    const runDryRunPreflight = body.runDryRunPreflight !== false;

    const result = await validateThemeProposal(candidate, {
      allowExistingId,
      runDryRunPreflight,
    });

    return jsonResponse(
      {
        valid: result.valid,
        errors: result.errors,
        warnings: result.warnings,
        ...(result.dryRunPreflight ? { dryRunPreflight: result.dryRunPreflight } : {}),
      },
      { status: 200, requestId },
    );
  } catch (err) {
    return handleApiError(err, requestId);
  }
}
