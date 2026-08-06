'use client';

/**
 * EntityDetail — one person or company, and everything that involves them.
 *
 * The whole page is the `related` list, and that is the design rather than a
 * shortcoming: an entity is a **lens, not a container**. It owns nothing, and it is
 * deliberately absent from `score.ts` (§1) — so there is no task list, no score, no
 * progress, only "what in my brain touches this".
 *
 * That is also exactly what §16.8b asserts about `/entities/[id]/view`: it returns
 * only this entity's linked items, and another user's entities never appear.
 */

import * as React from 'react';
import { Link2, Pencil } from 'lucide-react';

import { EntityForm } from '@/components/resparkable/entities/entity-form';
import { ArchiveControls } from '@/components/resparkable/ui/archive-controls';
import { MarkdownView } from '@/components/resparkable/ui/markdown-view';
import { RelatedList } from '@/components/resparkable/ui/related-list';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ClientDate } from '@/components/ui/client-date';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { RESPARKABLE_ROUTES } from '@/lib/framework/resparkable/ui/routes';
import type { EntityViewWire } from '@/lib/framework/resparkable/ui/payloads';
import { sanitizeUrl } from '@/lib/security/sanitize';

export function EntityDetail({ view }: { view: EntityViewWire }): React.ReactElement {
  const [editOpen, setEditOpen] = React.useState(false);
  const { entity, related } = view;

  // The website is user-supplied text that becomes an anchor — the one place on
  // this page where a `javascript:` scheme would otherwise be clickable.
  const website = entity.website ? sanitizeUrl(entity.website) : '';

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold">{entity.name}</h1>
              <Badge variant="secondary">{entity.kind}</Badge>
              <Badge variant={entity.status === 'active' ? 'default' : 'outline'}>
                {entity.status}
              </Badge>
              {entity.archivedAt !== null && <Badge variant="outline">archived</Badge>}
            </div>

            <p className="text-muted-foreground text-xs">
              {entity.lastActivityAt ? (
                <>
                  last involved <ClientDate date={entity.lastActivityAt} />
                </>
              ) : (
                'nothing recorded yet'
              )}
              {website && (
                <>
                  {' · '}
                  <a
                    href={website}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="hover:underline"
                  >
                    {entity.website}
                  </a>
                </>
              )}
            </p>
          </div>

          <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
            <Pencil className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Edit
          </Button>
        </div>

        {entity.description && <MarkdownView content={entity.description} />}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Link2 className="h-4 w-4" aria-hidden="true" />
            Everything involving them
          </CardTitle>
        </CardHeader>
        <CardContent>
          <RelatedList
            related={related}
            emptyMessage="Nothing linked yet. Mention them in a note or link a project to them, and it shows up here — the connection sweep will also propose links it spots on its own."
          />
        </CardContent>
      </Card>

      <ArchiveControls
        collection={RESPARKABLE_API.ENTITIES}
        id={entity.id}
        label={entity.name}
        noun="person or company"
        archived={entity.archivedAt !== null}
        redirectTo={RESPARKABLE_ROUTES.ENTITIES}
      />

      <EntityForm open={editOpen} onOpenChange={setEditOpen} entity={entity} />
    </div>
  );
}
