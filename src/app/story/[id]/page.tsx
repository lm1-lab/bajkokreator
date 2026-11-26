import { notFound } from 'next/navigation';
import { StoryReader } from '@/components/StoryReader';
import { STORY_ID_REGEX } from '@/lib/storage/security';
import { getStory } from '@/lib/storage/store';

export const dynamic = 'force-dynamic';

interface StoryPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ slide?: string | string[]; view?: string | string[] }>;
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function StoryViewerPage({
  params,
  searchParams,
}: StoryPageProps) {
  const { id } = await params;
  if (!STORY_ID_REGEX.test(id)) {
    notFound();
  }

  const story = await getStory(id);
  if (!story) {
    notFound();
  }

  const query = await searchParams;
  const rawView = firstParam(query.view);
  const rawSlide = firstParam(query.slide);
  const maxSlide = story.pages.length + 2;

  const parsedSlide = rawSlide !== undefined ? Number.parseInt(rawSlide, 10) : 0;
  const clampedSlide = Number.isFinite(parsedSlide)
    ? Math.min(maxSlide, Math.max(0, parsedSlide))
    : 0;
  const initialViewAll = rawView === 'all';

  return (
    <StoryReader
      initialStory={story}
      initialSlide={clampedSlide}
      initialViewAll={initialViewAll}
    />
  );
}
