/**
 * Per-section help copy: what each Resparkable section is, and how things get into it.
 *
 * ## Why this exists
 *
 * Nothing on these screens says where its contents came from. The inbox does not
 * say what put items in it, the Areas page does not say that a blank weekly
 * target switches off 15% of every task's score, and the Connections queue does
 * not say that rejecting a suggestion is what stops it coming back. Each section
 * therefore gets a one-line blurb that is always visible and a ⓘ popover with
 * the rest.
 *
 * ## The copy rules
 *
 * **Plain, neutral English.** Short sentences, no rhetorical framing, no jokes,
 * no "and that is the entire design". The code comments in this tier argue for
 * their decisions; the help text does not — it states what happens. If a
 * sentence would read oddly in a manual, it does not belong here.
 *
 * **Say the number.** 0.55, 03:15, 15%, "must add up to 1". Vague help is worse
 * than none because it cannot be checked against the code when the code changes.
 *
 * ## Why the copy is data rather than JSX in fifteen components
 *
 * It is one file to keep true when the machinery changes, and it means a
 * section's help exists whether or not its page remembered to render a header —
 * the shell renders {@link SectionHeader} once for every route, from this table.
 *
 * ## The matching rule
 *
 * Longest matching `href` wins, so `/resparkable/projects/clx…` inherits the
 * Projects entry. `TODAY` is `exact` because every Resparkable path starts with
 * `/resparkable` and would otherwise match it.
 *
 * Detail routes have no entries of their own: "what is a project detail page" is
 * the same question as "what is a project".
 */

import { RESPARKABLE_ROUTES } from '@/lib/framework/resparkable/ui/routes';

export interface SectionHelpBlock {
  /** Short, plain heading — "How things get here", not "Ingestion pipeline". */
  heading: string;
  /** Newlines are preserved when rendered, so a short list is fine here. */
  body: string;
}

export interface SectionHelpEntry {
  href: string;
  /** Index route — match exactly, or it wins every comparison. */
  exact?: boolean;
  title: string;
  /** One line, always on screen. The popover is for everything else. */
  blurb: string;
  blocks: SectionHelpBlock[];
  /** Places to go next, rendered at the foot of the popover. */
  links?: Array<{ href: string; label: string }>;
}

export const RESPARKABLE_SECTION_HELP: readonly SectionHelpEntry[] = [
  {
    href: RESPARKABLE_ROUTES.TODAY,
    exact: true,
    title: 'Today',
    blurb: 'Your ranked task list, the day’s time blocks, and the morning briefing.',
    blocks: [
      {
        heading: 'What’s on this page',
        body: 'Tasks in priority order, the time blocks you booked for today, goals with a deadline coming up, a few suggested connections, and the briefing. Nothing is created here — it all comes from the other sections.',
      },
      {
        heading: 'How tasks are ordered',
        body: 'Each task has a priority score built from six factors: urgency (30%), goal alignment (25%), project momentum (15%), area balance (15%), effort fit (10%) and staleness (5%). Any manual boost is added on top. Scores are recalculated overnight and whenever a task changes, not while you are reading the page.',
      },
      {
        heading: 'Two factors need input from you',
        body: 'Area balance uses the minutes you booked against each area this week. Effort fit compares a task’s estimate to the largest free gap in your day. If you don’t set weekly targets in Areas and book time in Plan, neither factor has any effect on the order.',
      },
      {
        heading: 'The briefing',
        body: 'Written automatically at 04:30 in your timezone and saved. This page shows the saved copy, so it loads immediately. Use Regenerate if you want a new one now.',
      },
    ],
    links: [
      { href: RESPARKABLE_ROUTES.PLAN, label: 'Book time for today' },
      { href: RESPARKABLE_ROUTES.AREAS, label: 'Set weekly targets' },
    ],
  },

  {
    href: RESPARKABLE_ROUTES.INBOX,
    title: 'Inbox',
    blurb: 'Notes you’ve captured, waiting to be sorted.',
    blocks: [
      {
        heading: 'How things get here',
        body:
          'Anything you capture arrives here. There are four ways to capture:\n' +
          '• The capture drawer, available on every Resparkable page (⌘/Ctrl+K).\n' +
          '• Asking the chat assistant to note something down.\n' +
          '• The same tool from your editor, over MCP.\n' +
          '• POST /api/v1/resparkable/capture — used by phone shortcuts, share sheets and email hooks.\n' +
          'If a request includes an externalId, sending it twice returns the original note instead of creating a duplicate.',
      },
      {
        heading: 'Nothing else appears here',
        body: 'Only captured notes. A task you create in Projects, or a file you upload to Documents, does not pass through the inbox.',
      },
      {
        heading: 'What to do with a note',
        body: 'Decide what it is. Promoting it turns it into a task, project or goal, and records what the note became along with a link between the two. You can also snooze it until a date, which removes it from this list until then, or drop it.',
      },
      {
        heading: 'The suggestions on each card',
        body: 'Resparkable compares each note to everything else you have written and suggests items it may relate to. The most likely project is offered as a one-click way to file it.',
      },
      {
        heading: 'Overnight sorting',
        body: 'A triage agent runs at 03:15 in your timezone. It promotes notes it can classify confidently and leaves the rest alone. It cannot delete a note.',
      },
    ],
    links: [{ href: RESPARKABLE_ROUTES.CONNECTIONS, label: 'Review suggested connections' }],
  },

  {
    href: RESPARKABLE_ROUTES.CHAT,
    title: 'Chat',
    blurb: 'Ask questions about your own material.',
    blocks: [
      {
        heading: 'What it already knows',
        body: 'Today’s date, your goals, what you are working on and how much of the week is left are given to it before you type. It can also search your material, read your ranked task list, get an overview of everything, read the briefing and look at connections.',
      },
      {
        heading: 'What it can change',
        body: 'It can capture a note, promote one, create or update tasks, projects, goals and people, and link items together. It is instructed to do this only when you ask. Each reply lists which tools it used.',
      },
      {
        heading: 'Conversations are not stored in your brain',
        body: 'Chat messages are not indexed and will not appear in search results. If something in a reply is worth keeping, capture it.',
      },
    ],
  },

  {
    href: RESPARKABLE_ROUTES.BOARDS,
    title: 'Boards',
    blurb: 'A kanban view of tasks that already exist.',
    blocks: [
      {
        heading: 'Boards don’t own tasks',
        body: 'Each column is a task status. Moving a card changes the status of the real task, and that change appears in Projects and on Today. Deleting a board does not delete any tasks.',
      },
      {
        heading: 'Two kinds of board',
        body: 'A filter board shows whatever currently matches its filter, ordered by priority score. An explicit board shows a set you choose, in an order you arrange. Cards can only be reordered by hand on an explicit board.',
      },
      {
        heading: 'Column limits',
        body: 'Going over a column’s limit highlights the column but does not block the move. The card still goes where you put it.',
      },
      {
        heading: 'Card age',
        body: 'Cards show how long they have been in their current column, measured from the recorded status change. Where there is no such record — the card was created and never moved, or was moved before this was tracked — the card shows time since its last edit instead, and says which of the two it is showing.',
      },
    ],
  },

  {
    href: RESPARKABLE_ROUTES.PROJECTS,
    title: 'Projects',
    blurb: 'Anything that takes more than one step.',
    blocks: [
      {
        heading: 'What they’re for',
        body: 'Projects hold tasks. A task’s project is what connects it to a goal and to an area, and those two account for 40% of the task’s priority score. A task with no project ranks lower than the same task filed under one.',
      },
      {
        heading: 'How projects get here',
        body: 'Created on this page, promoted from an inbox note, or created by the chat assistant when you ask. The overnight triage agent cannot create projects.',
      },
      {
        heading: 'Status and snoozing',
        body: 'A project is idea, active, paused, done or abandoned. Only active projects are offered when filing an inbox note. Snoozing a project takes it and its tasks out of the ranking until a date you choose.',
      },
      {
        heading: 'How they’re searched',
        body: 'Projects are searchable by meaning. Their tasks are searched by keyword instead, because short task titles do not work well for meaning-based search.',
      },
    ],
  },

  {
    href: RESPARKABLE_ROUTES.GOALS,
    title: 'Goals',
    blurb: 'What the work is for. Goals can contain other goals.',
    blocks: [
      {
        heading: 'Why they’re shown as a tree',
        body: 'A long-term goal can contain the shorter-term goals that lead to it. The nesting is what shows which goal serves which.',
      },
      {
        heading: 'Effect on task order',
        body: 'Goal alignment is 25% of a task’s priority score, the largest single factor. Tasks in a project that is linked to an active goal rank higher than tasks that are not.',
      },
      {
        heading: 'Horizons and risk',
        body: 'A goal is set at life, year, quarter, month or week level. A goal with a target date in the next seven days that is not yet achieved is shown on Today as at risk.',
      },
      {
        heading: 'No separate page per goal',
        body: 'A goal is a short statement plus its child goals, so both are shown here and editing happens in a dialog from this list.',
      },
    ],
  },

  {
    href: RESPARKABLE_ROUTES.AREAS,
    title: 'Areas',
    blurb: 'The ongoing parts of your life, and how much of the week each should get.',
    blocks: [
      {
        heading: 'Areas are not projects',
        body: 'Areas are the parts of life that do not finish — health, family, the business, a craft. Projects belong to an area.',
      },
      {
        heading: 'Set a weekly target, or the area does nothing',
        body: 'Area balance is 15% of every task’s priority score. It compares the target minutes set here against the minutes you actually booked in Plan. An area with no target has no effect on scoring, even though it otherwise looks set up.',
      },
      {
        heading: 'Check the totals line',
        body: 'If your targets add up to more hours than a week contains, every area reads as neglected at the same time and the factor stops distinguishing between them. The page shows the total against the week so you can see this.',
      },
    ],
    links: [{ href: RESPARKABLE_ROUTES.PLAN, label: 'Book time against an area' }],
  },

  {
    href: RESPARKABLE_ROUTES.ENTITIES,
    title: 'People',
    blurb: 'People, companies and segments your work involves.',
    blocks: [
      {
        heading: 'How they get here',
        body: 'Added on this page, or created by the chat assistant when you ask. The overnight triage agent cannot create them.',
      },
      {
        heading: 'They are not ranked',
        body: 'People take no part in task scoring, so the list is not ordered by importance. It shows last activity instead, which tells you who you have not dealt with recently.',
      },
      {
        heading: 'They are searchable',
        body: 'People are indexed like everything else, so they appear in search results and can be matched to notes that mention them.',
      },
    ],
  },

  {
    href: RESPARKABLE_ROUTES.DOCUMENTS,
    title: 'Documents',
    blurb: 'Reference files, processed so their contents can be searched.',
    blocks: [
      {
        heading: 'What happens after upload',
        body: 'The file is read, split into chunks and indexed. This is not instant, and until the status says ready the document will not appear in search results. If processing failed, the reason is shown on the row.',
      },
      {
        heading: 'What they’re for',
        body: 'Documents are reference material. Their contents become searchable alongside your notes and projects. They never appear in your task ranking.',
      },
      {
        heading: 'Why download is sometimes missing',
        body: 'Whether the original file is kept after processing is a server setting, and the default is to discard it. The download button appears only when the file is still available.',
      },
    ],
  },

  {
    href: RESPARKABLE_ROUTES.CONNECTIONS,
    title: 'Connections',
    blurb: 'Suggested links between your items, waiting for you to accept or reject.',
    blocks: [
      {
        heading: 'Where suggestions come from',
        body: 'Resparkable compares items that are already indexed and suggests pairs that are similar enough. The threshold is 0.55 by default and can be changed in Settings. The comparison uses data that already exists and costs nothing to run, so you can check for new suggestions as often as you like.',
      },
      {
        heading: 'Note-to-note is the useful comparison',
        body: 'Two notes written weeks apart that turn out to be about the same thing is the main thing this finds. Projects and goals tend to match things you already knew were related.',
      },
      {
        heading: 'Accepting and rejecting',
        body: 'Accepting creates a real link, visible on both items and in the graph. Rejecting records that you said no, which is what stops the same pair being suggested again. Rejected suggestions are kept rather than deleted for that reason.',
      },
      {
        heading: 'Partial runs are reported',
        body: 'If there were more items than a run could check, it says so. That is different from having found nothing.',
      },
    ],
    links: [{ href: RESPARKABLE_ROUTES.SETTINGS, label: 'Change the similarity threshold' }],
  },

  {
    href: RESPARKABLE_ROUTES.GRAPH,
    title: 'Graph',
    blurb: 'A view of what one item connects to.',
    blocks: [
      {
        heading: 'It starts from one item',
        body: 'Choose an item and see what it connects to, one step out by default. There is no view of everything at once: a full graph is too dense to read, so this one needs a starting point and limits how many items it draws.',
      },
      {
        heading: 'When the view is cut short',
        body: 'If the limit is reached, the view says so, so you can tell that apart from an item that simply has few connections.',
      },
      {
        heading: 'What is not shown',
        body: 'Archived items do not appear, because archiving removes them from the index. Rejected suggestions are not drawn either.',
      },
    ],
  },

  {
    href: RESPARKABLE_ROUTES.PLAN,
    title: 'Plan',
    blurb: 'Book time for the day.',
    blocks: [
      {
        heading: 'Why this affects your task order',
        body: 'Area balance, 15% of a task’s priority score, is based on the minutes you booked against an area this week. Effort fit compares a task’s estimate to the largest free gap in your day. With no time booked, area balance treats every area as neglected and effort fit has no effect.',
      },
      {
        heading: 'One day at a time',
        body: 'This is a day planner rather than a calendar.',
      },
      {
        heading: 'Times are local to this browser',
        body: 'A block at 2pm means 2pm where you are. Snoozes work differently: they use the timezone set in Settings, because they have to happen at the same moment whichever device set them.',
      },
      {
        heading: 'Plan and actual are separate',
        body: 'Blocks are labelled plan, actual or calendar, so what you intended and what happened do not overwrite each other.',
      },
    ],
  },

  {
    href: RESPARKABLE_ROUTES.VAULT,
    title: 'Vault',
    blurb: 'Your whole brain as a folder of markdown, out and back in.',
    blocks: [
      {
        heading: 'What the export is',
        body: 'A zip of plain markdown files with YAML frontmatter — one file per area, goal, project, task, thought and person, plus a README that describes the format. Nothing in it needs Resparkable to be readable. Open the folder in Obsidian and it is a working vault; an export of an empty brain is a starter vault, because it is the same code path.',
      },
      {
        heading: 'Two folders go out and never come back',
        body: 'Reviews are regenerated on a schedule, so an edit to one would be overwritten by the next run — better to not read them than to lose your paragraph silently. A document note is a stub: the title, the metadata and a preview of the extracted text. The original file stays here, because round-tripping a 40 MB PDF through every export costs a lot and Obsidian cannot edit it anyway.',
      },
      {
        heading: 'Import always shows you the plan first',
        body: 'Uploading an archive gives you a per-file diff — what would be created, what would change, what is unchanged, and what was skipped and why. Nothing is written until you apply it. The plan is computed either way, so previewing is free.',
      },
      {
        heading: 'resparkable-id is what makes an import an update',
        body: 'That line in the frontmatter is the identity. Rename a file, move it, edit it — it stays the same item. Delete the line and re-import, and you get a second copy. An id that is not yours is treated as a new item rather than as an address, so a vault from somebody else can never overwrite your rows.',
      },
      {
        heading: 'Import never deletes',
        body: 'Anything missing from the archive is left alone. The nearest it comes to losing work is a file whose body has gone empty, and that is refused unless you tick the box — a truncated or half-synced file is a much more common cause of an empty body than somebody meaning it.',
      },
      {
        heading: 'What comes back',
        body: 'Frontmatter fields and note bodies. Ticking a checkbox in the generated block inside a project note, which changes the real task. And any [[wikilink]] in your prose, as a suggested connection waiting in Connections — never as an accepted one, so a passing mention cannot move anything up your ranking.',
      },
    ],
    links: [{ href: RESPARKABLE_ROUTES.CONNECTIONS, label: 'Review connections from your vault' }],
  },

  {
    href: RESPARKABLE_ROUTES.SETTINGS,
    title: 'Settings',
    blurb: 'Settings that change how Resparkable behaves.',
    blocks: [
      {
        heading: 'Timezone',
        body: 'Snooze times, retention windows, the 03:15 triage run, the 04:30 briefing and the weekly review all use this setting rather than server time. It defaults to UTC, so if you do not change it, all of those happen at the wrong hour.',
      },
      {
        heading: 'Scoring weights must add up to 1',
        body: 'This keeps the base score between 0 and 1, which is what makes a manual boost of +1 rank above everything unboosted. The form shows the running total as you edit.',
      },
      {
        heading: 'Connection threshold',
        body: 'The default of 0.55 suits the default indexing model. A different model needs a different value. Set too high, it produces no suggestions at all, which looks the same as having nothing to suggest.',
      },
      {
        heading: 'Work style',
        body: 'Changes which items the morning briefing leads with, not just its wording.',
      },
    ],
    links: [{ href: RESPARKABLE_ROUTES.ARCHIVE, label: 'Archive and items that have gone quiet' }],
  },

  {
    href: RESPARKABLE_ROUTES.SEARCH,
    title: 'Search',
    blurb: 'Search your material by meaning.',
    blocks: [
      {
        heading: 'Meaning, not just keywords',
        body: 'Notes, projects, goals, areas, people and documents are matched by meaning, so a search can find things that do not use your exact words. Tasks are matched by keyword instead, because short titles do not work well for meaning-based search.',
      },
      {
        heading: 'Each search does real work',
        body: 'Your search text has to be processed before anything can be ranked against it. That is why this section has its own rate limit, why results are not cached, and why changing a filter runs a new search.',
      },
      {
        heading: 'Include archived',
        body: 'Archived items are not in the meaning-based index, so this option adds a keyword-only search over them rather than widening the main one.',
      },
    ],
  },

  {
    href: RESPARKABLE_ROUTES.ARCHIVE,
    title: 'Archive',
    blurb: 'Items you have put away, and items that have gone quiet.',
    blocks: [
      {
        heading: 'Two sections',
        body: 'The top section lists items nothing has touched in a while and asks whether they are still relevant. Nothing there is archived unless you say so, and marking something as still live updates its activity date so it stops being listed. The list below shows what you have archived, plus items archived automatically — only completed tasks, closed projects and untouched inbox notes are archived that way, and nothing is deleted.',
      },
      {
        heading: 'What archiving does',
        body: 'It removes the item from the index, so it no longer appears in search results, connection suggestions or the graph. It stays readable here, and can be found by keyword using “include archived” in Search. Restoring an item puts it back and re-indexes it.',
      },
      {
        heading: 'Why this isn’t in the menu',
        body: 'Archived items are things you decided to stop thinking about, so there is no permanent link to them. You reach this page from Settings or from the monthly review.',
      },
    ],
  },
];

/**
 * The entry describing `pathname`, or `null` where nothing matches.
 *
 * Longest match wins so detail routes inherit their section, and `exact` entries
 * are compared whole — `/resparkable` would otherwise prefix-match every page in the
 * product.
 */
export function findSectionHelp(pathname: string): SectionHelpEntry | null {
  let best: SectionHelpEntry | null = null;

  for (const entry of RESPARKABLE_SECTION_HELP) {
    const matches = entry.exact
      ? pathname === entry.href
      : pathname === entry.href || pathname.startsWith(`${entry.href}/`);

    if (!matches) continue;
    if (!best || entry.href.length > best.href.length) best = entry;
  }

  return best;
}
