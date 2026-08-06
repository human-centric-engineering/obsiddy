/**
 * `/resparkable/vault` — Obsidian import and export (§14, Release 3).
 *
 * The only Resparkable page that fetches nothing. Both halves are user-initiated
 * file transfers, and a page that read the whole brain just to say "you have
 * 412 notes" would pay the cost of an export to render a number nobody acts on.
 *
 * The heading and the ⓘ come from `RESPARKABLE_SECTION_HELP` via the shell's
 * `<SectionHeader>`, like every other section.
 */

import type { Metadata } from 'next';

import { VaultExportCard } from '@/components/resparkable/vault/vault-export-card';
import { VaultImportCard } from '@/components/resparkable/vault/vault-import-card';

export const metadata: Metadata = {
  title: 'Vault',
  description: 'Your brain as a folder of markdown — out to Obsidian and back.',
};

export default function ResparkableVaultPage() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <VaultExportCard />
      <VaultImportCard />
    </div>
  );
}
