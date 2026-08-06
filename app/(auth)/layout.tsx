import type { Metadata } from 'next';
import Link from 'next/link';
import { ThemeToggle } from '@/components/theme-toggle';
import { BrandMark } from '@/components/brand/brand-mark';
import { BRAND } from '@/lib/brand';

export const metadata: Metadata = {
  title: {
    template: `%s - ${BRAND.name}`,
    default: `Authentication - ${BRAND.name}`,
  },
  description: 'Sign in or create an account',
};

/**
 * Auth Layout
 *
 * Minimal centered layout for authentication pages (login, signup, etc.)
 * No navigation or footer - just centered content on a clean background
 */
export default function AuthLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    /**
     * The auth pages are the only screens someone sees before they have any
     * reason to trust the product, so this is where the aesthetic has to arrive
     * fully formed rather than being introduced gradually once you're inside.
     *
     * The layout stays what it was — one centred card, no nav, no footer —
     * because the job is still "sign in and leave". What's added is the brand
     * above the card (an unlabelled card floating on a black field could belong
     * to anything) and the field itself, so the grid and the ember bloom are the
     * first things established.
     */
    <div className="obsidian-field min-h-screen">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="w-full max-w-md space-y-6">
          {/* Home is the only way out of this screen for someone who arrived by
              accident; the wordmark is where everyone looks for it. */}
          <Link
            href="/"
            className="flex justify-center text-xl transition-opacity hover:opacity-75"
          >
            <BrandMark />
          </Link>
          {children}
        </div>
      </div>
    </div>
  );
}
