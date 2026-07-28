/**
 * Obsiddy-declared server environment variables.
 *
 * Obsiddy exports this schema from its own tier; the **host** merges it into
 * `appEnvSchema` in `lib/app/env.ts` with one line (see
 * `.context/framework/obsiddy/install.md`). Obsiddy deliberately does not own
 * `lib/app/env.ts` — that file is the *leaf* seam, and the host wants it for
 * its own variables too.
 *
 * `lib/env.ts` folds `appEnvSchema` into the same fail-fast startup parse as
 * the core variables, and rejects any key that collides with a core one — so
 * every key here must stay `OBSIDDY_`-prefixed.
 *
 * **Every Obsiddy variable is optional with a working default.** A host that
 * merges this schema and sets nothing must still boot: the module is installed
 * feature-by-feature across phases, and a required variable would turn "I
 * haven't reached that phase yet" into a startup crash.
 *
 * Variables arrive with the phase that reads them, not before:
 *   - `OBSIDDY_INBOX_DOMAIN` — email-to-inbox capture (Release 1, phase 9)
 *   - `OBSIDDY_GIT_ALLOWED_HOSTS` — git-remote allowlist (Release 4, phase 19)
 */
import { z } from 'zod';

export const obsiddyEnvSchema = z.object({});

export type ObsiddyEnv = z.infer<typeof obsiddyEnvSchema>;
