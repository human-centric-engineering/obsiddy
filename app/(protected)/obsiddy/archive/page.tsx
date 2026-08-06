import type { Metadata } from 'next';
import { z } from 'zod';

import { ArchivedList } from '@/components/obsiddy/lifecycle/archived-list';
import { StaleDigest } from '@/components/obsiddy/lifecycle/stale-digest';
import { LoadError } from '@/components/obsiddy/ui/load-error';
import { OBSIDDY_API } from '@/lib/framework/obsiddy/api/endpoints';
import {
  entitySchema,
  goalSchema,
  projectSchema,
  staleDigestSchema,
  taskSchema,
  thoughtSchema,
} from '@/lib/framework/obsiddy/ui/payloads';
import { readObsiddy } from '@/lib/framework/obsiddy/ui/server-read';

export const metadata: Metadata = {
  title: 'Archive',
  description: 'What has gone quiet, and what you have put away.',
};

/**
 * The lifecycle surface: what has gone quiet, and what is already archived.
 *
 * ## Why the two live on one page
 *
 * They are the same story at two stages. The digest asks "is this still live?";
 * the archive holds what the answer was no to — plus everything retention aged
 * out on its own. Splitting them would leave two pages neither of which anyone
 * has a reason to visit, and the digest's most useful moment is exactly when
 * someone has come to tidy up.
 *
 * ## Why this is not in the main nav
 *
 * §11 is explicit that the archived list views and `?includeArchived=true` are
 * the only two ways to reach archived items. A permanent nav link to your own
 * archive puts the things you decided to stop thinking about back in front of
 * you every day, which is the opposite of what archiving is for. It is linked
 * from Settings and from the monthly review — both places you go on purpose.
 *
 * ## One fetch per section, none per row
 *
 * Six requests, fixed, whatever the archive holds. `includeArchived=only` is
 * what makes this an archive rather than a longer list: `true` would mix the
 * archived rows in among everything still live.
 */
export default async function ObsiddyArchivePage() {
  const archived = (collection: string): string => `${collection}?includeArchived=only&limit=100`;

  const [digest, projects, goals, tasks, thoughts, entities] = await Promise.all([
    readObsiddy(OBSIDDY_API.STALE, staleDigestSchema),
    readObsiddy(archived(OBSIDDY_API.PROJECTS), z.array(projectSchema)),
    readObsiddy(archived(OBSIDDY_API.GOALS), z.array(goalSchema)),
    readObsiddy(archived(OBSIDDY_API.TASKS), z.array(taskSchema)),
    readObsiddy(archived(OBSIDDY_API.THOUGHTS), z.array(thoughtSchema)),
    readObsiddy(archived(OBSIDDY_API.ENTITIES), z.array(entitySchema)),
  ]);

  // Only the digest is load-bearing enough to fail the page. An archive section
  // that could not be read is rendered empty with its own message rather than
  // taking the other five down with it.
  if (!digest.ok) {
    return <LoadError what="what has gone quiet" message={digest.message} />;
  }

  return (
    <div className="space-y-10 p-4 md:p-6">
      {/* No heading here: the shell's `<SectionHeader>` names the section, and its
          ⓘ carries what this header used to say — that nothing was deleted, and
          that only completed tasks, closed projects and untouched notes age out. */}
      <section>
        <h2 className="text-lg font-semibold">Gone quiet</h2>
        <p className="text-muted-foreground mt-1 mb-4 text-sm">
          Age is a poor guide to whether something still matters, so these are questions rather than
          decisions. Nothing here is archived unless you say so.
        </p>
        <StaleDigest digest={digest.data} />
      </section>

      <section className="space-y-6">
        <h2 className="text-lg font-semibold">Archived</h2>

        <div>
          <h3 className="mb-2 text-base font-semibold">Projects</h3>
          <ArchivedList
            items={projects.ok ? projects.data.map(fromNamed) : []}
            collection={OBSIDDY_API.PROJECTS}
            noun="project"
            emptyLabel={
              projects.ok ? 'No archived projects.' : 'Archived projects could not be loaded.'
            }
          />
        </div>

        <div>
          <h3 className="mb-2 text-base font-semibold">Goals</h3>
          <ArchivedList
            items={goals.ok ? goals.data.map(withTitle) : []}
            collection={OBSIDDY_API.GOALS}
            noun="goal"
            emptyLabel={goals.ok ? 'No archived goals.' : 'Archived goals could not be loaded.'}
          />
        </div>

        <div>
          <h3 className="mb-2 text-base font-semibold">Tasks</h3>
          <ArchivedList
            items={tasks.ok ? tasks.data.map(withTitle) : []}
            collection={OBSIDDY_API.TASKS}
            noun="task"
            emptyLabel={tasks.ok ? 'No archived tasks.' : 'Archived tasks could not be loaded.'}
          />
        </div>

        <div>
          <h3 className="mb-2 text-base font-semibold">Notes</h3>
          <ArchivedList
            items={thoughts.ok ? thoughts.data.map(fromThought) : []}
            collection={OBSIDDY_API.THOUGHTS}
            noun="note"
            emptyLabel={thoughts.ok ? 'No archived notes.' : 'Archived notes could not be loaded.'}
          />
        </div>

        <div>
          <h3 className="mb-2 text-base font-semibold">People and companies</h3>
          <ArchivedList
            items={entities.ok ? entities.data.map(fromNamed) : []}
            collection={OBSIDDY_API.ENTITIES}
            noun="person or company"
            emptyLabel={
              entities.ok ? 'No archived people or companies.' : 'These could not be loaded.'
            }
          />
        </div>
      </section>
    </div>
  );
}

/**
 * Projects and entities carry `name`; goals and tasks carry `title`.
 *
 * The two mappers exist because the difference is real in the schema and worth
 * keeping there — a `title ?? name` in the component would quietly render an
 * empty string the day a type gains one and not the other.
 */
function fromNamed(row: {
  id: string;
  name: string;
  archivedAt: string | null;
  archivedReason?: string | null;
}) {
  return {
    id: row.id,
    title: row.name,
    archivedAt: row.archivedAt,
    archivedReason: row.archivedReason ?? null,
  };
}

/** Goals and tasks carry `title`; the list component asks for one shape. */
function withTitle(row: {
  id: string;
  title: string;
  archivedAt: string | null;
  archivedReason?: string | null;
}) {
  return {
    id: row.id,
    title: row.title,
    archivedAt: row.archivedAt,
    archivedReason: row.archivedReason ?? null,
  };
}

/**
 * A thought has no title — its content *is* the thing.
 *
 * Truncated to a line here rather than rendered whole: an archive listing is for
 * finding something again, and a wall of full note bodies is harder to scan than
 * a list of first lines. The full text is a click away at the item's own URL,
 * which archiving deliberately leaves working.
 */
function fromThought(row: {
  id: string;
  content: string;
  archivedAt: string | null;
  archivedReason?: string | null;
}) {
  const firstLine = row.content.split('\n')[0] ?? '';
  return {
    id: row.id,
    title: firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine || 'Empty note',
    archivedAt: row.archivedAt,
    archivedReason: row.archivedReason ?? null,
  };
}
