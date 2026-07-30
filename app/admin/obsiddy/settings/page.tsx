import type { Metadata } from 'next';

import { DocumentSettingsForm } from '@/components/obsiddy/admin/document-settings-form';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { OBSIDDY_API } from '@/lib/framework/obsiddy/api/endpoints';
import { obsiddyAdminSettingsResponseSchema } from '@/lib/framework/obsiddy/validations';
import { logger } from '@/lib/logging';

export const metadata: Metadata = {
  title: 'Settings · Obsiddy',
  description: 'How this deployment handles uploaded documents.',
};

/**
 * Read the settings through the API rather than the repo.
 *
 * Slightly indirect for a server component, but it keeps one implementation of
 * "what are the effective settings" — including the resolved storage capability,
 * which the form's whole layout depends on — rather than a page that computes it
 * one way and the API another. Parsed with Zod because a fetch response is
 * external data, even when we wrote the endpoint (CLAUDE.md: no `as` on external
 * data).
 */
async function getSettings() {
  try {
    const response = await serverFetch(OBSIDDY_API.ADMIN.SETTINGS);
    if (!response.ok) return null;
    const body = await parseApiResponse<unknown>(response);
    if (!body.success) return null;
    return obsiddyAdminSettingsResponseSchema.parse(body.data);
  } catch (error) {
    logger.error('Obsiddy admin settings page: fetch failed', error);
    return null;
  }
}

export default async function ObsiddySettingsPage() {
  const settings = await getSettings();

  return (
    <div className="space-y-6">
      <header className="bg-background sticky top-0 z-30 -mx-6 border-b px-6 pt-3 pb-3">
        <h1 className="text-2xl font-semibold">Obsiddy Settings</h1>
        <p className="text-muted-foreground text-sm">
          Deployment-wide handling of uploaded documents. These are operator settings — everything
          else in Obsiddy belongs to the individual user.
        </p>
      </header>

      {settings ? (
        <DocumentSettingsForm initial={settings} />
      ) : (
        <div className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          <p className="font-medium">Couldn&rsquo;t load settings.</p>
          <p className="mt-1">
            Obsiddy is running on its defaults — originals discarded after parsing, 25 MB upload
            ceiling. Check the server logs for the failure and reload.
          </p>
        </div>
      )}
    </div>
  );
}
