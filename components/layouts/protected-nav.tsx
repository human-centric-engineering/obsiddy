'use client';

/**
 * Protected Navigation Component
 *
 * Navigation links for protected routes.
 * Highlights the current page.
 * Shows admin link only to admin users.
 *
 * Phase 3.2: User Management
 * Phase 4.4: Admin Dashboard link
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { useSession } from '@/lib/auth/client';
import { LayoutDashboard, User, Settings, Shield, Brain } from 'lucide-react';

const navItems = [
  {
    href: '/dashboard',
    label: 'Dashboard',
    icon: LayoutDashboard,
    adminOnly: false,
  },
  // FRAMEWORK-TIER ENTRY (Obsiddy) — the one Sunrise-owned line Obsiddy edits.
  //
  // There is no `lib/app/protected-nav.ts` seam yet, so a framework tier cannot
  // contribute a nav item the way it contributes an admin section
  // (`lib/app/admin-nav.ts`). Filed upstream as sunrise#473 and recorded as ask
  // #2 in `.context/framework/obsiddy/sunrise-asks.md`; `install.md` §2.11
  // documents this line as the interim workaround for host projects.
  //
  // When the seam lands: delete this entry, register through the seam instead,
  // and move the ask to the Landed table.
  {
    href: '/obsiddy',
    label: 'Obsiddy',
    icon: Brain,
    adminOnly: false,
  },
  {
    href: '/profile',
    label: 'Profile',
    icon: User,
    adminOnly: false,
  },
  {
    href: '/settings',
    label: 'Settings',
    icon: Settings,
    adminOnly: false,
  },
  {
    href: '/admin',
    label: 'Admin',
    icon: Shield,
    adminOnly: true,
  },
];

export function ProtectedNav() {
  const pathname = usePathname();
  const { data: session } = useSession();

  const isAdmin = session?.user?.role === 'ADMIN';

  return (
    <nav className="flex items-center gap-1">
      {navItems
        .filter((item) => !item.adminOnly || isAdmin)
        .map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
          const Icon = item.icon;

          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
              )}
              aria-current={isActive ? 'page' : undefined}
            >
              <Icon className="h-4 w-4" />
              <span className="hidden sm:inline">{item.label}</span>
            </Link>
          );
        })}
    </nav>
  );
}
