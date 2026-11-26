import { CreatorStudio } from '@/components/CreatorStudio';
import { buildSettingsSnapshot } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const snapshot = await buildSettingsSnapshot();
  return (
    <CreatorStudio
      initialSettings={snapshot.settings}
      providers={snapshot.providers}
      quota={snapshot.quota}
    />
  );
}
