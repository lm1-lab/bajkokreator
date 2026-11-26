import { NextResponse } from 'next/server';
import { getProvider, type ReferencePhotoBinary } from '@/lib/ai/provider';
import { handleApiError, toReferencePhotoBinary } from '@/lib/api-helpers';
import { releaseDailyQuota, reserveDailyQuota } from '@/lib/storage/quota';
import { assertValidStoryId, extensionForMime } from '@/lib/storage/security';
import {
  getRuntimeSettings,
  getStory,
  readStoryAsset,
  saveStory,
  saveStoryAsset,
} from '@/lib/storage/store';
import type { StoryPage } from '@/lib/types/story';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(
  _request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  let reservedQuota = 0;
  let usedQuota = 0;

  try {
    const { id } = await context.params;
    const safeId = assertValidStoryId(id);
    const story = await getStory(safeId);
    if (!story) {
      return NextResponse.json(
        { error: 'Nie znaleziono bajki o podanym identyfikatorze.', code: 'NOT_FOUND' },
        { status: 404 },
      );
    }

    const pendingPages = story.pages.filter(
      (p) => p.imageStatus === 'pending' || p.imageStatus === 'error',
    );
    if (pendingPages.length === 0) {
      return NextResponse.json(
        {
          story: { ...story, generationStage: 'complete' },
          generatedPages: [],
        },
        { status: 200 },
      );
    }

    const provider = getProvider(story.provider);
    const runtimeSettings = await getRuntimeSettings();

    if (provider.consumesQuota) {
      await reserveDailyQuota(pendingPages.length);
      reservedQuota = pendingPages.length;
    }

    const referenceBinaries: ReferencePhotoBinary[] = [];
    for (const refName of story.referencePhotos) {
      const asset = await readStoryAsset(safeId, refName);
      if (asset) {
        referenceBinaries.push(
          toReferencePhotoBinary(refName, asset.mimeType, asset.buffer),
        );
      }
    }

    let coverStyleAnchor: ReferencePhotoBinary | null = null;
    if (story.coverFilename) {
      const coverAsset = await readStoryAsset(safeId, story.coverFilename);
      if (coverAsset) {
        coverStyleAnchor = toReferencePhotoBinary(
          story.coverFilename,
          coverAsset.mimeType,
          coverAsset.buffer,
        );
      }
    }

    const now = new Date().toISOString();
    const generatedPages: number[] = [];
    const updatedPages: StoryPage[] = [...story.pages];

    for (const pending of pendingPages) {
      const idx = updatedPages.findIndex((p) => p.pageNumber === pending.pageNumber);
      if (idx === -1) continue;

      const art = await provider.generateIllustration({
        slot: pending.pageNumber,
        prompt: pending.imagePrompt,
        characterBible: story.characterBible,
        artStyle: story.input.artStyle,
        bookFormat: story.bookFormat,
        referencePhotos: referenceBinaries,
        coverStyleAnchor,
        totalPages: story.pages.length,
        imageModel: runtimeSettings.imageModel,
      });

      if (art) {
        if (provider.consumesQuota) usedQuota += 1;
        if (art.kind === 'binary' && art.buffer) {
          const ext = extensionForMime(art.mimeType);
          const filename = `page-${pending.pageNumber}.${ext}`;
          await saveStoryAsset(safeId, filename, art.buffer);
          updatedPages[idx] = {
            ...updatedPages[idx],
            imageFilename: filename,
            imageStatus: 'ready',
            imageUpdatedAt: now,
          };
          generatedPages.push(pending.pageNumber);
        } else if (art.kind === 'demo-asset' && art.demoAssetPath) {
          updatedPages[idx] = {
            ...updatedPages[idx],
            demoAssetPath: art.demoAssetPath,
            imageStatus: 'ready',
            imageUpdatedAt: now,
          };
          generatedPages.push(pending.pageNumber);
        }
      }
    }

    const remainingPending = updatedPages.some(
      (p) => p.imageStatus === 'pending' || p.imageStatus === 'error',
    );

    const updatedStory = {
      ...story,
      generationStage: remainingPending
        ? story.generationStage
        : ('complete' as const),
      pages: updatedPages,
      updatedAt: now,
    };

    await saveStory(updatedStory);

    const unused = Math.max(0, reservedQuota - usedQuota);
    if (unused > 0) {
      await releaseDailyQuota(unused);
      reservedQuota -= unused;
    }

    return NextResponse.json(
      {
        story: updatedStory,
        generatedPages,
      },
      { status: 200 },
    );
  } catch (err) {
    const unused = Math.max(0, reservedQuota - usedQuota);
    if (unused > 0) {
      await releaseDailyQuota(unused).catch(() => undefined);
    }
    return handleApiError(err);
  }
}
