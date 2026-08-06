import { z } from 'zod';

import { resparkableEnvSchema } from '@/lib/framework/resparkable/env';

/**
 * App-defined server environment variables.
 *
 * **Fork-owned scaffold** — Resparkable ships this empty and does NOT change it
 * after release, so your edits here merge cleanly when you pull an upstream
 * version (the stable contract is this file's export, not its body). Treat it
 * like the landing page: a starting point you're expected to modify.
 *
 * `lib/env.ts` merges this into the same fail-fast startup parse as the core
 * vars; server-side only. Extend, e.g.:
 *   `export const appEnvSchema = z.object({ STRIPE_SECRET_KEY: z.string().min(1) });`
 *
 * Resparkable declares its own variables in `lib/framework/resparkable/env.ts` and this
 * file merges them — the one-line host wiring from
 * `.context/framework/resparkable/install.md`. Unlike the boot seam, this import is
 * necessarily static (the schema is read during a synchronous module-load
 * parse), so removing the Resparkable tier means removing this line too.
 *
 * Full guide: CUSTOMIZATION.md §4 · .context/environment/overview.md
 */
export const appEnvSchema = z.object({}).merge(resparkableEnvSchema);
