import { cn } from '@/lib/utils';

/** Where a release actually is. Named for the reader, not for the tracker. */
export type RoadmapStatus = 'shipped' | 'partly shipped' | 'designed' | 'planned';

export interface RoadmapEntry {
  title: string;
  status: RoadmapStatus;
  body: string;
  /** Optional second paragraph, for the entries that need the caveat spelled out. */
  note?: string;
}

/**
 * Dot colour per status.
 *
 * These are the **signal** tokens, not `primary`, and that is the point: signals
 * are meanings and must not move when the brand does. A "shipped" marker that
 * turned amber because someone re-pointed the accent would be saying something
 * it does not mean. `primary` appears on this rail only as the connector line.
 *
 * `planned` gets no colour at all — a hollow ring in the border colour. Absence
 * of a signal is the honest rendering of a thing that does not exist yet.
 */
const STATUS_DOT: Record<RoadmapStatus, string> = {
  shipped: 'bg-signal',
  'partly shipped': 'bg-signal/45',
  designed: 'bg-info/60',
  planned: 'border-border border bg-transparent',
};

/**
 * RoadmapRail — the four releases, plus the one that comes after them.
 *
 * **Fork-owned.** Nothing upstream has this shape, and it is the section most
 * likely to go stale, so it is a component taking data rather than markup buried
 * in a page: the copy that has to be re-checked every release lives in one array
 * at the call site.
 *
 * ## Why the status is a word and not a bar
 *
 * A percentage-complete bar is a claim about the future. "Partly shipped" plus a
 * sentence naming exactly what is missing is a claim about the present, and it
 * is the only kind a roadmap can actually keep. Each entry therefore states what
 * is outstanding rather than how far along it is.
 */
export function RoadmapRail({ entries }: { entries: RoadmapEntry[] }): React.ReactNode {
  return (
    <ol className="relative">
      {/* The connector, fading out under the last entry — the rail runs on past
          the end of what has been decided, which is the true shape of it. */}
      <span
        className="from-primary/45 absolute top-2 bottom-8 left-[3px] w-px bg-gradient-to-b to-transparent"
        aria-hidden="true"
      />

      {entries.map((entry) => (
        <li key={entry.title} className="relative pb-10 pl-8 last:pb-0">
          <span
            className={cn(
              'absolute top-[7px] left-0 h-[7px] w-[7px] rounded-full',
              STATUS_DOT[entry.status]
            )}
            aria-hidden="true"
          />
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 className="font-medium">{entry.title}</h3>
            <span className="term-meta">{entry.status}</span>
          </div>
          <p className="text-muted-foreground mt-2 leading-relaxed">{entry.body}</p>
          {entry.note ? (
            <p className="text-muted-foreground/80 mt-2 text-sm leading-relaxed">{entry.note}</p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
