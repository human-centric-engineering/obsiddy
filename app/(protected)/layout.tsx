import type { Metadata } from 'next';
import { AppHeader } from '@/components/layouts/app-header';
import { ProtectedNav } from '@/components/layouts/protected-nav';
import { ProtectedFooter } from '@/components/layouts/protected-footer';
import { MaintenanceWrapperWithAdminNotice } from '@/components/maintenance-wrapper';
import { BRAND } from '@/lib/brand';
import { AUTH_LANDING_ROUTE } from '@/lib/auth-landing/route';

export const metadata: Metadata = {
  title: {
    template: `%s - ${BRAND.name}`,
    default: `Dashboard - ${BRAND.name}`,
  },
  description: 'Your dashboard',
};

/**
 * Protected Layout
 *
 * Layout for all protected routes (dashboard, settings, profile, etc.)
 * Protected by proxy - unauthenticated users are redirected to /login
 *
 * Phase 3.2: Added navigation links
 * Phase 4.4: Added maintenance mode support
 */
export default function ProtectedLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <MaintenanceWrapperWithAdminNotice>
      <div className="bg-background flex min-h-screen flex-col">
        {/* Full-bleed: this is an application, not a document. `container`
            capped it at the largest breakpoint and centred the remainder, which
            on a wide display spent ~450px on empty margins while the app's own
            sidebar sat mid-screen. See `.app-shell` in `globals.css`. */}
        <AppHeader logoHref={AUTH_LANDING_ROUTE} navigation={<ProtectedNav />} fullWidth />
        <main className="app-shell flex-1 py-8">{children}</main>
        <ProtectedFooter />
      </div>
    </MaintenanceWrapperWithAdminNotice>
  );
}
