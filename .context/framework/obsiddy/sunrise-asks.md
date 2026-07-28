# Sunrise Asks

Things Obsiddy needs from **upstream Sunrise** — seams that don't exist yet,
core files a fork is currently forced to edit, and platform gaps that will bite
a later release.

Upstream repo: <https://github.com/human-centric-engineering/sunrise>

## Why this file exists

Obsiddy is a framework-tier module, so **every edit to a Sunrise-owned file is a
merge conflict inflicted on every host project** that installs Obsiddy. When
Obsiddy needs something core doesn't expose, the answer is a seam upstream — not
a local edit. This file is the register of those requests, so they don't quietly
turn into "just this once" edits that make install #2 an archaeology exercise
(risk 1b in [`plan.md`](./plan.md#17-risks-ranked-by-likelihood-of-biting)).

Obsiddy is not the only fork doing this. Daybreak, Reclaim Your Week, ConQuest
and HCE Hub all file upstream asks the same way — several of the seams Obsiddy
needs were already raised by one of them. **Search before filing.**

## The process

When a Sunrise gap surfaces during Obsiddy work:

1. **Search upstream first** — `gh issue list --repo
human-centric-engineering/sunrise --state all --limit 300`. Roughly half of
   Obsiddy's first batch turned out to be already filed by another fork. A
   comment on an existing issue with a second fork's use case is worth more than
   a duplicate.
2. **Add a row below** — what's needed, why, and what Obsiddy does until it
   lands.
3. **Open an issue** (or comment on the existing one) and put the number in the
   Issue column. A row without an issue is a note to self; an issue is a request
   someone can action.
4. **Record the workaround in [`install.md`](./install.md)** if a host project
   has to do anything differently until the seam lands.
5. When it ships upstream, **remove the workaround, move the row to Landed, and
   note the Sunrise version**.

House style upstream: what the gap is, what it cost a real build, what would
close it, and a "downstream status" note saying what the fork carries locally in
the meantime.

---

## Already raised upstream — Obsiddy is a second data point

Both of Obsiddy's blocking asks were already filed by other forks. Add Obsiddy's
use case as a comment rather than opening a duplicate.

| #   | Ask                                                                                                                           | Upstream                                                                            | Obsiddy's angle                                                                                                                                                                                                                                                                | Until then                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| 1   | **A seam for an app's own recurring job** — Obsiddy wants `registerAppMaintenanceTask({ name, run })` on the maintenance tick | [#469](https://github.com/human-centric-engineering/sunrise/issues/469) OPEN        | #469 proposes `lib/app/scheduled-jobs.ts` driven by the **scheduler**; Obsiddy's connection sweep, retention pass and (Release 4) vault sync want the **maintenance tick** — batch-of-5, `SKIP LOCKED`, 60s budget. Same gap, and the tick angle is worth adding to the thread | One documented line in `run-tick.ts`. See `install.md` §2.8       |
| 2   | **`lib/app/protected-nav.ts`** — a protected-nav seam mirroring `lib/app/admin-nav.ts`                                        | [#473](https://github.com/human-centric-engineering/sunrise/issues/473) OPEN        | Identical gap, found independently. #473 also covers the hardcoded `/dashboard` post-auth destination in eight places, which Obsiddy will hit the moment `/obsiddy` becomes the product's real home                                                                            | One documented line in `protected-nav.tsx`. See `install.md` §2.9 |
| 8   | **Per-user scheduling** — `AiWorkflowSchedule` has `createdBy` but no per-user notion                                         | folded into [#469](https://github.com/human-centric-engineering/sunrise/issues/469) | Obsiddy rides the maintenance tick instead, which is the right call for per-user sweeps anyway. Low priority                                                                                                                                                                   | —                                                                 |

---

## Affects Obsiddy's design — open upstream, not our ask

| Upstream                                                                     | What                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Why Obsiddy cares                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#462](https://github.com/human-centric-engineering/sunrise/issues/462) OPEN | **Boot-registered context contributors and capability handlers are lost at request time under Next 16 + Turbopack.** `instrumentation.ts` runs in a separate module graph from route handlers; the request-path self-heal re-runs core's built-ins and the **app** tier, but not a **framework** tier that registered at boot. Silent — no error, the tools and the context block simply aren't there. Proposed fix: back both registries with `globalThis` | **This is Obsiddy's exact shape.** Phase 6 registers 14 capabilities and a context contributor from `initObsiddy()`; phase 7 adds more. On Turbopack they would silently vanish at request time. Either #462 lands first, or phase 6 needs a request-path self-heal of its own. **Decide before writing phase 6, not after debugging it.** Reclaim Your Week carries the `globalThis` fix locally |
| [#367](https://github.com/human-centric-engineering/sunrise/issues/367) OPEN | Intra-tenant ownership-scope seam (owner/team-scoped resource visibility)                                                                                                                                                                                                                                                                                                                                                                                   | Adjacent to Obsiddy's D5 `OwnerScope`, but not blocking — Obsiddy owns its scope boundary inside its own tier. Worth watching in case the platform seam supersedes it                                                                                                                                                                                                                             |
| [#429](https://github.com/human-centric-engineering/sunrise/issues/429) OPEN | `prisma/schema/app.prisma` ships platform models despite docs implying it's fork-reserved                                                                                                                                                                                                                                                                                                                                                                   | The `/framework` tier Obsiddy uses **is** genuinely reserved, so Obsiddy is unaffected — but the resolution may change the leaf-tier advice in `install.md`                                                                                                                                                                                                                                       |
| [#442](https://github.com/human-centric-engineering/sunrise/issues/442) OPEN | Maintenance tick does unconditional DB work every 60s                                                                                                                                                                                                                                                                                                                                                                                                       | Obsiddy adds more per-tick work; whatever shape #442's fix takes, Obsiddy's tasks have to fit it                                                                                                                                                                                                                                                                                                  |

---

## Not yet filed — Obsiddy's own, checked against the 88 existing issues

| #   | Ask                                                                                                                                                                                          | Why                                                                                                                                                                                                                                                                                                                                                                                                                                   | Priority                                                 | Issue       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ----------- |
| 3   | **Make `tests/unit/lib/app/defaults.test.ts` fork-tolerant** — e.g. split the "seam is empty" assertions into a file forks are expected to replace, or drive them from a fork-owned manifest | The file asserts every `lib/app/*` seam ships empty. Valuable contract — but it means **any fork that fills any seam must edit a Sunrise-owned test**, which is exactly the merge conflict the seam model exists to prevent. Obsiddy hit it on its first commit (the ESLint seam) and will hit it again on every seam it fills. Sibling in spirit to #382, which added the ESLint seam without adjusting the test that locks it empty | **Worth filing** — cheap, recurring cost                 | _not filed_ |
| 4   | **A non-static way to contribute env vars** — `registerEnvSchema()` from the boot seam, or an explicit doc note                                                                              | `appEnvSchema` is read during a synchronous module-load parse in `lib/env.ts`, so a framework tier can only contribute vars via a **static** `@/lib/framework/...` import — contradicting the dynamic-import rule `CUSTOMIZATION.md` §4 sets for the boot seam. May well be "document the trade-off" rather than build a mechanism                                                                                                    | Worth filing — low, possibly docs-only                   | _not filed_ |
| 5   | **Admin/avatar test flake under parallel load**                                                                                                                                              | Observed 2026-07-28 on one machine: three full-suite runs failed 1–5 tests in **different** files each time, all `waitFor` timeouts, all passing in isolation. One run had a `next build` running concurrently, so the evidence is weak — **confirm against CI history before filing**, or it's noise from a loaded laptop                                                                                                            | **Hold** — needs CI evidence                             | _not filed_ |
| 6   | **DNS resolution in `checkSafeProviderUrl`** (`lib/security/safe-url.ts`) — resolve with `dns.lookup({ all: true })`, re-check every address, re-run on each redirect hop                    | The guard kills `ssh://`, `git://`, `file://` and `ext::` but does no DNS resolution, so a hostname resolving to a private address passes. Distinct from #437 (`sanitizeUrl` whitespace bypass) — different function, different bypass. Obsiddy ships its own `remote-guard.ts` regardless, but the gap affects every outbound fetch                                                                                                  | File when Release 4 starts, or sooner as a security note | _not filed_ |
| 7   | **Decide who owns per-user credential storage** — an AES-256-GCM `secret-box` with optional env keys, fail-closed                                                                            | No encryption utility exists anywhere (zero hits for `createCipheriv\|aes-256\|kms`), and `AiWorkflowTrigger.signingSecret` is plaintext under a documented "the DB is admin-trusted" posture that does not survive user-owned third-party tokens. **Needs a decision, not necessarily code** — if Sunrise doesn't want it, Obsiddy builds it in its own tier                                                                         | File when Release 4 is real                              | _not filed_ |
| 9   | **Reconcile the two upload caps** — 5 MB global (`lib/validations/storage.ts:15`) vs the bulk knowledge route's local 50 MB / 10 files                                                       | Obsiddy's document ingestion (phase 4) has to pick one and looks inconsistent either way. Minor                                                                                                                                                                                                                                                                                                                                       | Note only                                                | _not filed_ |

---

## Landed

_Nothing yet._

| #   | Ask | Landed in | Notes |
| --- | --- | --------- | ----- |
