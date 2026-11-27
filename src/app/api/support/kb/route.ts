import { NextResponse } from 'next/server';
import {
  getOrCreateRequestId,
  handleApiError,
  jsonResponse,
} from '@/lib/api-helpers';
import {
  getKnowledgeBaseCategories,
  searchKnowledgeBase,
} from '@/lib/support/knowledge-base';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const requestId = getOrCreateRequestId(request);
  try {
    const url = new URL(request.url);
    const q = url.searchParams.get('q') ?? undefined;
    const category = url.searchParams.get('category') ?? undefined;
    const rawLimit = url.searchParams.get('limit');
    const limit = rawLimit ? Number.parseInt(rawLimit, 10) : undefined;

    const result = searchKnowledgeBase({
      q,
      category,
      ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
    });

    return jsonResponse(
      {
        articles: result.articles,
        total: result.total,
        categories: getKnowledgeBaseCategories(),
      },
      { status: 200, requestId },
    );
  } catch (err) {
    return handleApiError(err, requestId);
  }
}
