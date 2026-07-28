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

## The process

When a Sunrise gap surfaces during Obsiddy work:

1. **Add a row below** — what's needed, why, and what Obsiddy does until it
   lands.
2. **Open an issue on the Sunrise repo** (`gh issue create --repo
human-centric-engineering/sunrise`) and put the number in the Issue column.
   A row without an issue is a note to self; an issue is a request someone can
   action.
3. **Record the workaround in [`install.md`](./install.md)** if a host project
   has to do anything differently until the seam lands.
4. When the seam ships upstream, **remove the workaround, tick the row, and note
   the Sunrise version** it landed in.

Do not batch these up for later — the cost of a missing seam is paid by every
fork, and the context for a good issue is freshest the moment it bites.

---

## Blocking — a phase needs a core edit without these

| #   | Ask                                                                                                                                                          | Why                                                                                                                                                                                                                | Until then                                                                                                                    | Issue       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 1   | **`lib/app/maintenance-tasks.ts`** — a `registerAppMaintenanceTask({ name, run })` seam mirroring the existing `lib/app/capabilities.ts` pattern (~30 lines) | `lib/orchestration/maintenance/run-tick.ts` runs 8 tasks under `Promise.allSettled` and has no registration point. Obsiddy's connection sweep, retention pass and (Release 4) vault sync all need to ride the tick | One documented line added to `run-tick.ts` — the only core edit Obsiddy tolerates, and a temporary one. See `install.md` §2.8 | _not filed_ |
| 2   | **`lib/app/protected-nav.ts`** — a protected-nav seam mirroring `lib/app/admin-nav.ts`                                                                       | `components/layouts/protected-nav.tsx` hard-codes its entries. Every host installing Obsiddy would have to hand-edit it to get an `/obsiddy` nav item                                                              | One documented line in `protected-nav.tsx`. See `install.md` §2.9                                                             | _not filed_ |

Both are **phase 0b** in the plan. Neither blocks phase 1, but #1 blocks phase 7
and #2 blocks phase 5.

---

## Friction — found while building, no workaround needed but the seam is worse for it

| #   | Ask                                                                                                                                                                                          | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Issue       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 3   | **Make `tests/unit/lib/app/defaults.test.ts` fork-tolerant** — e.g. split the "seam is empty" assertions into a file forks are expected to replace, or drive them from a fork-owned manifest | The file asserts every `lib/app/*` seam ships empty. That is a genuinely valuable contract — but it means **any fork that fills any seam must edit a Sunrise-owned test**, which is exactly the merge conflict the seam model exists to prevent. Obsiddy hit this on its first commit (the ESLint seam) and will hit it again on every seam it fills                                                                                                                                                      | _not filed_ |
| 4   | **A non-static way to contribute env vars** — e.g. `registerEnvSchema()` called from the boot seam, or an explicitly optional import                                                         | `appEnvSchema` in `lib/app/env.ts` is read during a synchronous module-load parse in `lib/env.ts`, so a framework tier can only contribute vars via a **static** `@/lib/framework/...` import. That directly contradicts the dynamic-import rule `CUSTOMIZATION.md` §4 sets for the boot seam, and means "the app still builds with `lib/framework/` deleted" isn't true for a tier that declares env vars. Possibly the right answer is just to **document the trade-off** rather than build a mechanism | _not filed_ |
| 5   | **Flaky admin integration tests under parallel load** — `tests/integration/app/admin/orchestration/agents/*-page.test.tsx` and `tests/unit/components/forms/avatar-upload.test.tsx`          | Observed 2026-07-28: three consecutive full-suite runs failed 1–5 tests in **different** files each time, all `waitFor` timeouts, all passing in isolation. Nothing to do with Obsiddy — but it makes "is the suite green?" an unreliable signal for every fork, and it will mask a real regression eventually                                                                                                                                                                                            | _not filed_ |

---

## Later releases — not blocking yet, worth deciding upstream

| #   | Ask                                                                                                                                                                                        | Needed by                          | Why                                                                                                                                                                                                                                                                                                                                                                                                                                | Issue       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 6   | **DNS resolution in `checkSafeProviderUrl`** (`lib/security/safe-url.ts`) — resolve the host with `dns.lookup({ all: true })` and re-check every address, plus re-run on each redirect hop | Release 4, phase 19                | The guard kills `ssh://`, `git://`, `file://` and `ext::` but does **no DNS resolution**, so a hostname resolving to a private address passes. Git remotes are 100% user-supplied with zero review. Obsiddy will ship its own `remote-guard.ts` regardless, but the DNS gap is a platform-level SSRF weakness that affects every outbound fetch, not just Obsiddy's                                                                | _not filed_ |
| 7   | **Decide who owns per-user credential storage** — an AES-256-GCM `lib/security/secret-box.ts` with optional env keys and fail-closed behaviour                                             | Release 4, phase 18                | No encryption utility exists anywhere in the repo (zero hits for `createCipheriv\|aes-256\|kms`), and `AiWorkflowTrigger.signingSecret` is plaintext under a documented "the DB is admin-trusted" posture. That posture does not survive user-owned third-party tokens. If Sunrise wants it, it should be Sunrise's; if not, Obsiddy builds it in its own tier and Sunrise stays as-is. **Needs a decision, not necessarily code** | _not filed_ |
| 8   | **Per-user scheduling on `AiWorkflowSchedule`**                                                                                                                                            | Release 1, phase 7 (worked around) | The model has `createdBy` but no per-user notion, so per-user scheduled work can't use the workflow scheduler. Obsiddy rides the maintenance tick instead — which is the right call for vault sync anyway, so this is low priority                                                                                                                                                                                                 | _not filed_ |
| 9   | **Reconcile the two upload caps**                                                                                                                                                          | —                                  | The global cap is 5 MB (`lib/validations/storage.ts:15`) while the bulk knowledge route defines its own 50 MB / 10-file limits locally. Obsiddy's document ingestion (phase 4) has to pick one and will look inconsistent either way                                                                                                                                                                                               | _not filed_ |

---

## Landed

_Nothing yet._

| #   | Ask | Landed in | Notes |
| --- | --- | --------- | ----- |
