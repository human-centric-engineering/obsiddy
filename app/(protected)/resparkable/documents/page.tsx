import type { Metadata } from 'next';
import { z } from 'zod';

import { DocumentsView } from '@/components/resparkable/documents/documents-view';
import { LoadError } from '@/components/resparkable/ui/load-error';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { documentSchema } from '@/lib/framework/resparkable/ui/payloads';
import { readResparkable } from '@/lib/framework/resparkable/ui/server-read';

export const metadata: Metadata = {
  title: 'Documents',
  description: 'Reference material the brain has read.',
};

export default async function ResparkableDocumentsPage() {
  const documents = await readResparkable(
    `${RESPARKABLE_API.DOCUMENTS}?limit=100`,
    z.array(documentSchema)
  );

  if (!documents.ok) {
    return <LoadError what="your documents" message={documents.message} />;
  }

  return <DocumentsView documents={documents.data} />;
}
