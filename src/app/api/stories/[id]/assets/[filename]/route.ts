import { NextResponse } from 'next/server';
import {
  errorResponse,
  getOrCreateRequestId,
  handleApiError,
} from '@/lib/api-helpers';
import {
  assertValidAssetFilename,
  assertValidStoryId,
} from '@/lib/storage/security';
import { readStoryAsset } from '@/lib/storage/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string; filename: string }>;
}

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  const requestId = getOrCreateRequestId(request);
  try {
    const { id, filename } = await context.params;
    const safeId = assertValidStoryId(id);
    const safeFilename = assertValidAssetFilename(filename);

    const asset = await readStoryAsset(safeId, safeFilename);
    if (!asset) {
      return errorResponse({
        error: 'Nie znaleziono żądanego pliku obrazu.',
        code: 'ASSET_NOT_FOUND',
        status: 404,
        requestId,
      });
    }

    // GDPR/RODO hygiene: never allow browsers or shared caches to retain child reference photos
    const isReferencePhoto = /^ref-/i.test(safeFilename);

    return new NextResponse(new Uint8Array(asset.buffer), {
      status: 200,
      headers: {
        'Content-Type': asset.mimeType,
        'Content-Length': String(asset.buffer.byteLength),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': isReferencePhoto ? 'no-store' : 'private, max-age=300',
        'X-Request-Id': requestId,
      },
    });
  } catch (err) {
    return handleApiError(err, requestId);
  }
}
