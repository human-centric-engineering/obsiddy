/**
 * MarkdownView — renders task notes, project descriptions and briefing prose.
 *
 * ## Why this duplicates the admin markdown component
 *
 * `components/admin/orchestration/markdown-or-raw-view.tsx` does the same job and
 * exports its class list. Importing it would couple a framework-tier component to
 * a Sunrise-owned admin module, which is exactly the coupling the tier exists to
 * avoid: a Sunrise upgrade that moves or renames that file breaks Obsiddy in a
 * host project that never touched either. `plan.md` §9 makes this call explicitly
 * for the chat interface and the same reasoning applies here — accepted
 * duplication for a clean fork seam.
 *
 * ## SECURITY — do not "improve" this by enabling raw HTML
 *
 * Only `remark-gfm` is enabled (tables, task lists, strikethrough, autolinks).
 * It is a parser-level extension and does **not** permit raw HTML, so a
 * `<script>` in someone's notes renders as inert text. Do not add `rehype-raw`
 * or `allowDangerousHtml`.
 *
 * That matters more here than in the admin UI. Notes arrive from an email inbox,
 * an iOS Shortcut, a voice transcript and an LLM — four paths where the content
 * is not something the reader typed. Release 2 then renders the same field to
 * *other people* through a share link. An XSS sink in this component would be a
 * stored, shared one.
 *
 * Links get `rel="noopener noreferrer nofollow"` and are run through
 * `sanitizeUrl()`, which strips `javascript:` and `data:` schemes that markdown
 * link syntax otherwise passes straight through.
 */

import * as React from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { sanitizeUrl } from '@/lib/security/sanitize';
import { cn } from '@/lib/utils';

/** Child-element styling for a markdown block. Kept tier-local on purpose. */
const MARKDOWN_CLASSES = [
  '[&>:first-child]:mt-0 [&>:last-child]:mb-0',
  '[&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0',
  '[&_ul]:my-2 [&_ul]:pl-5 [&_ul]:list-disc',
  '[&_ol]:my-2 [&_ol]:pl-5 [&_ol]:list-decimal',
  '[&_li]:my-0.5 [&_li>p]:my-0',
  '[&_h1]:my-2 [&_h1]:text-base [&_h1]:font-semibold',
  '[&_h2]:my-2 [&_h2]:text-base [&_h2]:font-semibold',
  '[&_h3]:my-2 [&_h3]:font-semibold',
  '[&_h4]:my-2 [&_h4]:font-semibold',
  '[&_strong]:font-semibold [&_em]:italic',
  '[&_code]:rounded-sm [&_code]:bg-foreground/10 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.9em]',
  '[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-foreground/5 [&_pre]:p-2',
  '[&_pre>code]:bg-transparent [&_pre>code]:p-0',
  '[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-2 [&_blockquote]:opacity-90',
  '[&_a]:text-primary [&_a]:underline',
  '[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_table]:text-xs',
  '[&_th]:border [&_th]:border-border [&_th]:bg-muted/60 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left',
  '[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_td]:align-top',
  '[&_hr]:my-3 [&_hr]:border-border',
  '[&_input[type=checkbox]]:mr-1',
].join(' ');

export interface MarkdownViewProps {
  content: string;
  className?: string;
}

export function MarkdownView({ content, className }: MarkdownViewProps): React.ReactElement {
  return (
    <div className={cn('text-sm leading-relaxed', MARKDOWN_CLASSES, className)}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children, ...rest }) => {
            const safe = href ? sanitizeUrl(href) : null;
            // A stripped scheme renders as plain text rather than a dead link:
            // a `javascript:` anchor that looks clickable is worse than no anchor.
            if (!safe) return <span>{children}</span>;
            return (
              <a {...rest} href={safe} target="_blank" rel="noopener noreferrer nofollow">
                {children}
              </a>
            );
          },
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}
