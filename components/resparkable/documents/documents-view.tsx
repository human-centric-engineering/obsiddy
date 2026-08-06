'use client';

/**
 * DocumentsView — uploaded reference material and what happened to it.
 *
 * ## Status is the whole point of this list
 *
 * Ingestion is asynchronous in effect: a document is parsed, chunked and embedded,
 * and until that finishes it is **not findable by meaning**. A list that showed only
 * titles would leave someone searching for a document they uploaded two minutes ago,
 * concluding search is broken. So `status` and `chunkCount` are first-class here, and
 * an errored document shows the parser's own reason rather than a generic failure.
 *
 * ## The download button is gated on `hasOriginal`, not on hope
 *
 * The list endpoint strips `storageKey` and returns `hasOriginal` in its place,
 * because whether a download exists depends on a deployment-wide operator setting
 * (`documentOriginals`) and on whether the storage provider can read an object back
 * at all. Rendering the button unconditionally would mean a 404 for every user of a
 * deployment that discards originals, which is the default.
 */

import * as React from 'react';
import { Download, FileText } from 'lucide-react';

import { DocumentUpload } from '@/components/resparkable/documents/document-upload';
import { ArchiveControls } from '@/components/resparkable/ui/archive-controls';
import { EmptyState } from '@/components/resparkable/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ClientDate } from '@/components/ui/client-date';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import type { DocumentWire } from '@/lib/framework/resparkable/ui/payloads';

/** What each status means for whether the document can be found yet. */
const STATUS_COPY: Record<string, string> = {
  processing: 'being read — not searchable yet',
  ready: 'indexed and searchable',
  failed: 'couldn’t be read',
};

export function DocumentsView({ documents }: { documents: DocumentWire[] }): React.ReactElement {
  return (
    <div className="space-y-4">
      <DocumentUpload />

      {documents.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No documents yet"
          description="Upload a contract, a spec, a book — anything you want the brain to know about. The text is extracted and indexed, so it turns up in search by meaning and in connection suggestions alongside your own notes."
        />
      ) : (
        <ul className="space-y-2">
          {documents.map((document) => (
            <li key={document.id} className="bg-card space-y-2 rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <FileText className="text-muted-foreground h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="font-medium">{document.title}</span>

                <Badge
                  variant={
                    document.status === 'ready'
                      ? 'default'
                      : document.status === 'failed'
                        ? 'destructive'
                        : 'secondary'
                  }
                  className="text-[11px]"
                >
                  {STATUS_COPY[document.status] ?? document.status}
                </Badge>

                {document.archivedAt !== null && (
                  <Badge variant="outline" className="text-[11px]">
                    archived
                  </Badge>
                )}

                <span className="text-muted-foreground ml-auto text-xs">
                  <ClientDate date={document.createdAt} />
                </span>
              </div>

              <p className="text-muted-foreground text-xs">
                {document.fileName} · {formatBytes(document.byteSize)}
                {document.status === 'ready' && (
                  <>
                    {' · '}
                    {document.chunkCount} {document.chunkCount === 1 ? 'passage' : 'passages'}{' '}
                    indexed
                  </>
                )}
              </p>

              {/* The parser's own reason — "encrypted PDF", "no extractable text" —
                  is more useful than anything this component could invent. */}
              {document.status === 'failed' && document.errorMessage && (
                <p className="text-destructive text-xs">{document.errorMessage}</p>
              )}

              <div className="flex flex-wrap items-center gap-2">
                {document.hasOriginal && (
                  <Button asChild variant="outline" size="sm">
                    <a href={RESPARKABLE_API.documentDownload(document.id)}>
                      <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                      Download original
                    </a>
                  </Button>
                )}

                <ArchiveControls
                  collection={RESPARKABLE_API.DOCUMENTS}
                  id={document.id}
                  label={document.title}
                  noun="document"
                  archived={document.archivedAt !== null}
                  compact
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
