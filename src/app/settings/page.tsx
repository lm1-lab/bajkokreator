import { SettingsPanel } from '@/components/SettingsPanel';
import { buildSettingsSnapshot } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const snapshot = await buildSettingsSnapshot();
  return <SettingsPanel initialSnapshot={snapshot} />;
}
