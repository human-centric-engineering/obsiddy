/**
 * Leaf boot seam — one-time server startup work for a project built **on
 * Resparkable**.
 *
 * **Resparkable-owned scaffold, host-editable** — Resparkable ships this empty and does
 * not change it after release, so a leaf fork's edits merge cleanly when it
 * pulls a newer Resparkable (the stable contract is this file's `initLeafApp`
 * export, not its body).
 *
 * Why this exists: `lib/app/bootstrap.ts` is the *Resparkable* boot seam, and
 * Resparkable already fills it to boot its framework tier. Without a second hook, a
 * leaf fork and Resparkable would both want to own that one file and every Resparkable
 * upgrade would be a merge conflict. So `initApp()` boots Resparkable, and Resparkable's
 * `initResparkable()` calls this — the leaf tier's own hook.
 *
 * Call order: Sunrise `register()` → `initApp()` → `initResparkable()` →
 * `initLeafApp()`. Resparkable's registrations therefore land **before** yours, so
 * you can override or extend them from here.
 *
 * Same rules as `bootstrap.ts`: this runs in every environment (production
 * included), once per server process, inside the try/catch `instrumentation.ts`
 * wraps around the boot chain — a throw is logged and swallowed, so prefer
 * degrading over failing.
 *
 * Full guide: `.context/framework/resparkable/install.md`
 */
export async function initLeafApp(): Promise<void> {
  // No leaf boot work by default.
}
