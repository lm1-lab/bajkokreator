import { LibraryShelf } from '@/components/LibraryShelf';
import { getStorageInfo, listStories } from '@/lib/storage/store';

export const dynamic = 'force-dynamic';

export default async function LibraryPage() {
  const [stories, storage] = await Promise.all([listStories(), getStorageInfo()]);
  return <LibraryShelf initialStories={stories} storageMode={storage.mode} />;
}
