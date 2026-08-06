'use client';

/**
 * Lease inspector — modal drill-in for a single execution's lease
 * state and the last 50 lease events.
 *
 * Answers operator questions like:
 *   - "Is the engine restarting?" → the history shows repeated
 *     `claimed`/`orphan-resume` events for one row.
 *   - "Who currently owns this row?" → `current.token` (redacted tail)
 *     and `current.expiresAt`.
 *   - "How many recovery cycles has this row been through?" →
 *     `current.recoveryAttempts` (engine caps at 3).
 *
 * Tokens are never shown in full — only the last 5 chars prefixed `…`.
 * The full token is a write-capability secret and never leaves the
 * server (the route applies the same redaction).
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';

export interface LeaseEventView {
  id: string;
  event: string;
  leaseToken: string | null;
  reason: string | null;
  metadata: unknown;
  createdAt: string;
}

export interface LeaseSnapshotView {
  current: {
    token: string | null;
    expiresAt: string | null;
    lastHeartbeatAt: string | null;
    recoveryAttempts: number;
  };
  history: LeaseEventView[];
}

const EVENT_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  claimed: 'default',
  released: 'secondary',
  'refresh-failed': 'outline',
  'orphan-resume': 'destructive',
  'force-failed': 'destructive',
};

export interface LeaseInspectorDialogProps {
  executionId: string | null;
  onClose: () => void;
}

export function LeaseInspectorDialog({
  executionId,
  onClose,
}: LeaseInspectorDialogProps): ReactElement {
  const [snapshot, setSnapshot] = useState<LeaseSnapshotView | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = executionId !== null;

  const load = useCallback(async (id: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.executionLease(id), {
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await parseApiResponse<LeaseSnapshotView>(res);
      if (!body.success) throw new Error('parse failed');
      setSnapshot(body.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'fetch failed');
      setSnapshot(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!executionId) {
      setSnapshot(null);
      return;
    }
    void load(executionId);
  }, [executionId, load]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Lease inspector</DialogTitle>
          <DialogDescription>
            {executionId ? (
              <>
                Execution {executionId.slice(0, 8)}… — current lease holder and recent transitions.
                Lease tokens are shown as a 5-char tail (e.g. <code>…ab12c</code>); the full token
                is a write-capability secret and never leaves the server.
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="border-destructive/50 bg-destructive/5 text-destructive rounded-md border px-3 py-2 text-sm">
            Could not load lease inspector ({error}).
          </div>
        )}

        {isLoading && !snapshot && <p className="text-muted-foreground text-sm">Loading…</p>}

        {snapshot && (
          <div className="space-y-4">
            <section className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <Field label="Token" value={snapshot.current.token ?? '—'} mono />
              <Field
                label="Expires"
                value={snapshot.current.expiresAt ? formatTime(snapshot.current.expiresAt) : '—'}
              />
              <Field
                label="Last heartbeat"
                value={
                  snapshot.current.lastHeartbeatAt
                    ? formatTime(snapshot.current.lastHeartbeatAt)
                    : '—'
                }
              />
              <Field label="Recovery attempts" value={String(snapshot.current.recoveryAttempts)} />
            </section>

            <section>
              <h3 className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
                Recent events ({snapshot.history.length})
              </h3>
              {snapshot.history.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No lease transitions recorded for this execution yet.
                </p>
              ) : (
                <div className="bg-card rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Event</TableHead>
                        <TableHead>Token</TableHead>
                        <TableHead>Reason</TableHead>
                        <TableHead className="text-right">When</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {snapshot.history.map((event) => (
                        <TableRow key={event.id}>
                          <TableCell>
                            <Badge variant={EVENT_VARIANT[event.event] ?? 'outline'}>
                              {event.event}
                            </Badge>
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {event.leaseToken ?? '—'}
                          </TableCell>
                          <TableCell className="text-xs">{event.reason ?? '—'}</TableCell>
                          <TableCell className="text-muted-foreground text-right text-xs">
                            {formatTime(event.createdAt)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): ReactElement {
  return (
    <div>
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className={mono ? 'font-mono text-sm' : 'text-sm'}>{value}</div>
    </div>
  );
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
