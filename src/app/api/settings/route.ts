import { NextResponse } from 'next/server';
import { buildSettingsSnapshot, handleApiError } from '@/lib/api-helpers';
import { saveRuntimeSettings } from '@/lib/storage/store';
import { PatchSettingsSchema } from '@/lib/types/story';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  try {
    const snapshot = await buildSettingsSnapshot();
    return NextResponse.json(snapshot, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PATCH(request: Request): Promise<NextResponse> {
  try {
    const rawBody: unknown = await request.json();
    const parsed = PatchSettingsSchema.parse(rawBody);
    await saveRuntimeSettings(parsed);
    const snapshot = await buildSettingsSnapshot();
    return NextResponse.json(snapshot, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
