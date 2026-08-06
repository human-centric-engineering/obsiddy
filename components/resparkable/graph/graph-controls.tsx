'use client';

/**
 * GraphControls — depth, node cap, and the truncation notice.
 *
 * Every change navigates, because every change is a different query: the walk
 * happens server-side under a node cap, so "show me two hops" cannot be answered
 * from what is already on screen. Keeping the state in the URL also makes a
 * particular view of the graph shareable and back-button-correct.
 *
 * The truncation notice is the part that earns its space. A graph that stopped at
 * the cap and a graph that ran out of connections look **identical** — same picture,
 * same absence of further edges — and mean opposite things: one says "there is more
 * here", the other says "this is all of it". Only the endpoint knows which happened,
 * so it reports `truncated` and this says so in words.
 */

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Info } from 'lucide-react';

import { FieldHelp } from '@/components/ui/field-help';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { RESPARKABLE_ROUTES } from '@/lib/framework/resparkable/ui/routes';

export interface GraphControlsProps {
  depth: number;
  nodeCap: number;
  nodeCount: number;
  truncated: boolean;
}

export function GraphControls({
  depth,
  nodeCap,
  nodeCount,
  truncated,
}: GraphControlsProps): React.ReactElement {
  const router = useRouter();
  const params = useSearchParams();

  function setParam(key: string, value: string): void {
    const search = new URLSearchParams(params.toString());
    search.set(key, value);
    router.push(`${RESPARKABLE_ROUTES.GRAPH}?${search.toString()}`);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="graph-depth" className="flex items-center gap-1.5 text-xs">
            How far out
            <FieldHelp title="Depth">
              <p>
                One hop shows what this is directly connected to. Two shows what those things
                connect to as well.
              </p>
              <p>
                It stops at two on purpose — beyond that a personal graph becomes a hairball that
                looks impressive and tells you nothing.
              </p>
            </FieldHelp>
          </Label>
          <Select value={String(depth)} onValueChange={(value) => setParam('depth', value)}>
            <SelectTrigger id="graph-depth" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">One hop</SelectItem>
              <SelectItem value="2">Two hops</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="graph-limit" className="text-xs">
            At most
          </Label>
          <Select value={String(nodeCap)} onValueChange={(value) => setParam('limit', value)}>
            <SelectTrigger id="graph-limit" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="25">25 things</SelectItem>
              <SelectItem value="50">50 things</SelectItem>
              <SelectItem value="150">150 things</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <p className="text-muted-foreground pb-2 text-xs">
          Showing {nodeCount} {nodeCount === 1 ? 'thing' : 'things'}
        </p>
      </div>

      {truncated && (
        <p
          className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
          role="status"
        >
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            There&rsquo;s more connected to this than fits — the picture stopped at {nodeCap}. Raise
            the limit, or click through a node to look at its own neighbourhood.
          </span>
        </p>
      )}
    </div>
  );
}
