import { CreatorStudio } from '@/components/CreatorStudio';
import { buildSettingsSnapshot } from '@/lib/api-helpers';
import { getActiveThemes } from '@/lib/catalog/themes';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const snapshot = await buildSettingsSnapshot();
  const activeThemes = getActiveThemes();
  return (
    <CreatorStudio
      initialSettings={snapshot.settings}
      providers={snapshot.providers}
      quota={snapshot.quota}
      themeInspirations={activeThemes}
    />
  );
}
