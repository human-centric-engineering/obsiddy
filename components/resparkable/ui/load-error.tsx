'use client';

/**
 * LoadError — what a surface shows when its one fetch failed.
 *
 * Every Resparkable page gets its data from a single enriched endpoint, which is the
 * right shape for performance and makes the failure total: there is no partial
 * page to fall back to. So the failure needs to be readable rather than a blank
 * region, and it needs a retry that actually retries — `router.refresh()`
 * re-runs the server component, which is the thing that failed.
 *
 * The message comes from the API's own error envelope where there is one. Those
 * strings are written by our handlers, so they are safe to show; a network-level
 * failure gets a generic line instead.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, RotateCw } from 'lucide-react';

import { Button } from '@/components/ui/button';

export interface LoadErrorProps {
  /** What failed, in the user's terms — "your tasks", "this project". */
  what: string;
  message: string;
}

export function LoadError({ what, message }: LoadErrorProps): React.ReactElement {
  const router = useRouter();

  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
    >
      <p className="flex items-center gap-2 font-medium">
        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
        Couldn&rsquo;t load {what}.
      </p>
      <p>{message}</p>
      <Button variant="outline" size="sm" onClick={() => router.refresh()}>
        <RotateCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
        Try again
      </Button>
    </div>
  );
}
