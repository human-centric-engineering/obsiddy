import type { Metadata } from 'next';
import { z } from 'zod';

import { DocumentsView } from '@/components/obsiddy/documents/documents-view';
import { LoadError } from '@/components/obsiddy/ui/load-error';
import { OBSIDDY_API } from '@/lib/framework/obsiddy/api/endpoints';
import { documentSchema } from '@/lib/framework/obsiddy/ui/payloads';
import { readObsiddy } from '@/lib/framework/obsiddy/ui/server-read';

export const metadata: Metadata = {
  title: 'Documents',
  description: 'Reference material the brain has read.',
};

export default async function ObsiddyDocumentsPage() {
  const documents = await readObsiddy(
    `${OBSIDDY_API.DOCUMENTS}?limit=100`,
    z.array(documentSchema)
  );

  if (!documents.ok) {
    return <LoadError what="your documents" message={documents.message} />;
  }

  return <DocumentsView documents={documents.data} />;
}
