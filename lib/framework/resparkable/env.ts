/**
 * Resparkable-declared server environment variables.
 *
 * Resparkable exports this schema from its own tier; the **host** merges it into
 * `appEnvSchema` in `lib/app/env.ts` with one line (see
 * `.context/framework/resparkable/install.md`). Resparkable deliberately does not own
 * `lib/app/env.ts` — that file is the *leaf* seam, and the host wants it for
 * its own variables too.
 *
 * `lib/env.ts` folds `appEnvSchema` into the same fail-fast startup parse as
 * the core variables, and rejects any key that collides with a core one — so
 * every key here must stay `RESPARKABLE_`-prefixed.
 *
 * **Every Resparkable variable is optional with a working default.** A host that
 * merges this schema and sets nothing must still boot: the module is installed
 * feature-by-feature across phases, and a required variable would turn "I
 * haven't reached that phase yet" into a startup crash.
 *
 * Variables arrive with the phase that reads them, not before:
 *   - `RESPARKABLE_INBOX_DOMAIN` — email-to-inbox capture (Release 1, phase 9)
 *   - `RESPARKABLE_GIT_ALLOWED_HOSTS` — git-remote allowlist (Release 4, phase 19)
 */
import { z } from 'zod';

export const resparkableEnvSchema = z.object({});

export type ResparkableEnv = z.infer<typeof resparkableEnvSchema>;
