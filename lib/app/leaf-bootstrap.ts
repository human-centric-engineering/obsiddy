/**
 * Leaf boot seam — one-time server startup work for a project built **on
 * Obsiddy**.
 *
 * **Obsiddy-owned scaffold, host-editable** — Obsiddy ships this empty and does
 * not change it after release, so a leaf fork's edits merge cleanly when it
 * pulls a newer Obsiddy (the stable contract is this file's `initLeafApp`
 * export, not its body).
 *
 * Why this exists: `lib/app/bootstrap.ts` is the *Sunrise* boot seam, and
 * Obsiddy already fills it to boot its framework tier. Without a second hook, a
 * leaf fork and Obsiddy would both want to own that one file and every Obsiddy
 * upgrade would be a merge conflict. So `initApp()` boots Obsiddy, and Obsiddy's
 * `initObsiddy()` calls this — the leaf tier's own hook.
 *
 * Call order: Sunrise `register()` → `initApp()` → `initObsiddy()` →
 * `initLeafApp()`. Obsiddy's registrations therefore land **before** yours, so
 * you can override or extend them from here.
 *
 * Same rules as `bootstrap.ts`: this runs in every environment (production
 * included), once per server process, inside the try/catch `instrumentation.ts`
 * wraps around the boot chain — a throw is logged and swallowed, so prefer
 * degrading over failing.
 *
 * Full guide: `.context/framework/obsiddy/install.md`
 */
export async function initLeafApp(): Promise<void> {
  // No leaf boot work by default.
}
