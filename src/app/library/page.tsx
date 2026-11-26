import { LibraryShelf } from '@/components/LibraryShelf';
import { getStorageRoot } from '@/lib/storage/paths';
import { listStories } from '@/lib/storage/store';

export const dynamic = 'force-dynamic';

export default async function LibraryPage() {
  const [stories, storage] = await Promise.all([listStories(), getStorageRoot()]);
  return <LibraryShelf initialStories={stories} storageMode={storage.mode} />;
}
