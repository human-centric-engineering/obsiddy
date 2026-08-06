/**
 * AppHeader Component
 *
 * Shared header component for public and protected layouts.
 * Provides consistent branding, navigation, and user actions.
 *
 * @example
 * // Protected layout with navigation
 * <AppHeader logoHref="/dashboard" navigation={<ProtectedNav />} />
 *
 * @example
 * // Public layout without navigation
 * <AppHeader logoHref="/" />
 */

import Link from 'next/link';
import { HeaderActions } from '@/components/layouts/header-actions';
import { BrandMark } from '@/components/brand/brand-mark';
import { cn } from '@/lib/utils';

interface AppHeaderProps {
  /** URL for logo click (default: "/") */
  logoHref?: string;
  /** Optional caller override for the brand slot; defaults to `<BrandMark/>`. */
  logoText?: string;
  /** Optional navigation component to display after logo */
  navigation?: React.ReactNode;
  /**
   * Span the viewport instead of the centred `container` measure.
   *
   * The signed-in app sets this so the header lines up with a full-bleed
   * `<main>` — a centred header above full-width content puts the brand and the
   * page's first pixel on different vertical lines, which is more obviously
   * wrong than either choice made consistently. Marketing keeps the default:
   * its sections are centred prose, and the header has to agree with them.
   */
  fullWidth?: boolean;
}

export function AppHeader({
  logoHref = '/',
  logoText,
  navigation,
  fullWidth = false,
}: AppHeaderProps) {
  return (
    <header className="border-b">
      <div
        className={cn(
          'flex items-center justify-between py-4',
          fullWidth ? 'app-shell' : 'container mx-auto px-4'
        )}
      >
        <div className="flex items-center gap-8">
          <Link href={logoHref} className="text-xl font-bold hover:opacity-80">
            {logoText ?? <BrandMark />}
          </Link>
          {navigation}
        </div>
        <HeaderActions />
      </div>
    </header>
  );
}
