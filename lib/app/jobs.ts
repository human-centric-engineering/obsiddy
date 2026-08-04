/**
 * App recurring-job registrations.
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's export, not its body). Treat it like the other
 * `lib/app/*` seams.
 *
 * Auto-wired: the maintenance tick calls this once before it first runs app jobs
 * (server runtime). Add `registerAppJob({ name, intervalMs, run })` calls to run
 * your own periodic work on the existing tick instead of standing up a second
 * scheduler:
 *
 *   import { registerAppJob } from '@/lib/orchestration/maintenance/app-jobs';
 *
 *   export function initAppJobs(): void {
 *     registerAppJob({
 *       name: 'app:prune-draft-invoices',
 *       intervalMs: 6 * 60 * 60 * 1000, // 6 hours
 *       run: async () => {
 *         const { count } = await prisma.appInvoice.deleteMany({ ... });
 *         return { pruned: count };   // folded into the tick's log line
 *       },
 *     });
 *   }
 *
 * `intervalMs` is a **minimum** gap, not a guarantee, and last-run times live in
 * process memory — so a multi-instance deployment runs each job about once per
 * instance per interval, and a restart re-arms everything. Write jobs to be
 * idempotent. If a job must run exactly once cluster-wide it needs its own lease;
 * see `execution-reaper` for that pattern.
 *
 * Empty registry = today's behaviour, byte-for-byte.
 *
 * Full guide: CUSTOMIZATION.md §4 · .context/orchestration/scheduling.md
 */
import { registerObsiddyJobs } from '@/lib/framework/obsiddy/jobs';

export function initAppJobs(): void {
  // Obsiddy's connection sweep — a continuous per-user pass over stored vectors,
  // which is why it rides the tick rather than a cron row (the other four
  // Obsiddy workflows are genuine calendar events and stay on `AiWorkflowSchedule`).
  //
  // Static import on purpose, like `lib/app/capabilities.ts` and
  // `lib/app/context-contributors.ts`: core calls this lazily from
  // `app-jobs.ts`, where there is nowhere to await, and this repo IS the Obsiddy
  // tier so the path always resolves. A host project adds the same two lines;
  // see `.context/framework/obsiddy/install.md`.
  registerObsiddyJobs();
}
