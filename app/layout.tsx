import type { Metadata } from 'next';
import { Suspense } from 'react';
import { headers } from 'next/headers';
import { Archivo, JetBrains_Mono, Martian_Mono } from 'next/font/google';
import '@/app/globals.css';
import '@/app/brand-theme.css'; // fork-owned per-surface palette; must cascade after globals
import { ThemeProvider } from '@/hooks/use-theme';
import { ErrorHandlingProvider } from '@/app/error-handling-provider';
import { ConsentProvider } from '@/lib/consent';
import { CookieBanner } from '@/components/cookie-consent';
import { AnalyticsProvider } from '@/lib/analytics';
import { AnalyticsScripts, UserIdentifier, PageTracker } from '@/components/analytics';
import { SurfaceSync } from '@/components/surface-sync';
import { DEFAULT_SURFACE } from '@/lib/app/surface';
import { BRAND } from '@/lib/brand';

/**
 * The three fonts, and the one rule that keeps them apart.
 *
 * Resparkable's premise is that the *chrome is an instrument and the content is a
 * page*: the shell around your notes should read like a terminal — dense,
 * aligned, monospaced — while the notes themselves should read like something a
 * person wrote. One family cannot do both jobs. A whole UI set in monospace is
 * the mistake the genre keeps making: it looks right in a screenshot and is
 * tiring to actually read a paragraph in.
 *
 * So each family has one job and never takes another's:
 *
 * - **Martian Mono** (`--font-display`) — headings, the wordmark, and the tracked
 *   micro-labels that name a region. Wide, mechanical, unmistakably a machine
 *   talking. Only ever used on short strings, where its width is a feature.
 * - **JetBrains Mono** (`--font-mono`) — anything that is *data*: ids, paths,
 *   timestamps, counts, code, the capture prompt. Drawn for small sizes on dark
 *   backgrounds, which is exactly where this app spends its time.
 * - **Archivo** (`--font-sans`) — body copy and note content. A tall-x-height
 *   grotesque that stays technical next to the two monos but reads at length.
 *
 * `display: 'swap'` on all three: a second brain that shows nothing for 300ms
 * while a webfont lands has failed at the only thing it does.
 */
const fontDisplay = Martian_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-resparkable-display',
  display: 'swap',
});

const fontMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-resparkable-mono',
  display: 'swap',
});

const fontSans = Archivo({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-resparkable-sans',
  display: 'swap',
});

export const metadata: Metadata = {
  title: `${BRAND.name} - Next.js Starter`,
  description:
    'A production-ready Next.js starter template designed for rapid application development',
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const headersList = await headers();
  const nonce = headersList.get('x-nonce') ?? undefined;
  // Rendering surface, classified per-request in proxy.ts. Drives the fork-owned
  // app/brand-theme.css (empty in vanilla Resparkable). On <html> so body-portaled
  // overlays inherit it; kept current across client nav by <SurfaceSync> below.
  const surface = headersList.get('x-surface') ?? DEFAULT_SURFACE;

  return (
    <html
      lang="en"
      data-surface={surface}
      // The font variables land on <html> rather than <body> so that
      // body-portaled overlays (Radix dialogs, the cookie modal) inherit them
      // for the same reason `data-surface` lives here — they mount outside the
      // React tree that any lower element would wrap.
      className={`${fontDisplay.variable} ${fontMono.variable} ${fontSans.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  const stored = localStorage.getItem('theme');
                  if (stored === 'light' || stored === 'dark') {
                    document.documentElement.classList.add(stored);
                  } else {
                    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
                    const theme = prefersDark ? 'dark' : 'light';
                    document.documentElement.classList.add(theme);
                    localStorage.setItem('theme', theme);
                  }
                } catch (e) {}
              })();
            `,
          }}
        />
      </head>
      <body suppressHydrationWarning>
        <SurfaceSync />
        <ErrorHandlingProvider>
          <ConsentProvider>
            <AnalyticsProvider>
              <ThemeProvider>
                {children}
                <CookieBanner />
              </ThemeProvider>
              <Suspense fallback={null}>
                <UserIdentifier />
                <PageTracker skipInitial />
              </Suspense>
              <AnalyticsScripts nonce={nonce} />
            </AnalyticsProvider>
          </ConsentProvider>
        </ErrorHandlingProvider>
      </body>
    </html>
  );
}
