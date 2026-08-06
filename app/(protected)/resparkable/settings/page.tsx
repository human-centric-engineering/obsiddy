import type { Metadata } from 'next';
import { z } from 'zod';

import { SpaceSettingsForm } from '@/components/resparkable/settings/space-settings-form';
import { LoadError } from '@/components/resparkable/ui/load-error';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { readResparkable } from '@/lib/framework/resparkable/ui/server-read';

export const metadata: Metadata = {
  title: 'Settings',
  description: 'Your timezone, your week, and how things get ranked.',
};

/**
 * Personal settings.
 *
 * These are the user's own, not the deployment's — `/admin/resparkable/settings` is the
 * operator surface and covers document handling. Nothing here is shared.
 *
 * `inboxToken` is deliberately absent from the payload: it is a bearer credential that
 * routes email into this brain, and a general settings read is exactly the kind of
 * response that ends up in a log or a bug report. It gets its own endpoint when email
 * capture lands.
 */
const settingsSchema = z.object({
  timezone: z.string(),
  weeklyCapacityMinutes: z.number(),
  workStyle: z.string(),
  priorityWeights: z.record(z.string(), z.number()),
  connectionStrengthFloor: z.number(),
  /** The eight §11 windows, resolved to defaults where the user has set none. */
  retentionPolicy: z.record(z.string(), z.number()),
});

export default async function ResparkableSettingsPage() {
  const result = await readResparkable(RESPARKABLE_API.SPACE, settingsSchema);

  if (!result.ok) {
    return <LoadError what="your settings" message={result.message} />;
  }

  return (
    <div className="max-w-2xl space-y-4">
      <p className="text-muted-foreground text-sm">
        Yours alone. Everything scheduled — snoozes, retention, &ldquo;tomorrow morning&rdquo; —
        resolves in the timezone below rather than the server&rsquo;s.
      </p>
      <SpaceSettingsForm initial={result.data} />
    </div>
  );
}
