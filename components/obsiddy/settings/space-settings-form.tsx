'use client';

/**
 * SpaceSettingsForm — the settings that change how the brain behaves.
 *
 * ## Timezone is the one that is silently wrong until it isn't
 *
 * Every snooze preset, every retention window and every "tomorrow at 9am" resolves in
 * `ObsiddySpace.timezone`, never in server time. The default is `UTC`, so a user who
 * never opens this page has every scheduling gesture landing at the wrong hour — a
 * task that unsnoozes at 2am because the server is in UTC is exactly the small
 * wrongness §10 calls careless. It is therefore the first field, and the copy says
 * what it governs.
 *
 * ## The weights must sum to 1, and the form enforces it
 *
 * `base` is a weighted average and the plan guarantees it lands in `[0, 1]` — which is
 * the entire reason a `manualBoost` of `+1` provably outranks every unboosted task
 * (§10). Weights summing to 1.4 break that guarantee, and the symptom is a pin that
 * doesn't pin, discovered months later. The API refuses it; this form shows the
 * running total so nobody has to submit to find out.
 *
 * ## The connection floor is model-dependent, which is why it is a setting
 *
 * Phase 4 shipped with the plan's 0.72 and the engine proposed nothing at all —
 * against the default embedding model that threshold sits above the signal. 0.55 is
 * the measured replacement. Anyone on a different model needs a different number, and
 * a sweep that is mis-tuned produces exactly the same output as a sweep that found
 * nothing.
 */

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { z } from 'zod';

import { FormError } from '@/components/forms/form-error';
import { SaveStatus, useSaveStatus } from '@/components/obsiddy/ui/save-status';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { apiClient } from '@/lib/api/client';
import { OBSIDDY_API } from '@/lib/framework/obsiddy/api/endpoints';
import { OBSIDDY_ROUTES } from '@/lib/framework/obsiddy/ui/routes';
import { PRIORITY_FACTORS, WORK_STYLES } from '@/lib/framework/obsiddy/validations';
import { cn } from '@/lib/utils';

const MINUTES_PER_HOUR = 60;

/** What each weight actually does, in the user's terms. */
const FACTOR_LABELS: Record<(typeof PRIORITY_FACTORS)[number], string> = {
  urgency: 'How soon it’s due',
  goalAlignment: 'Whether it serves a goal',
  projectMomentum: 'Whether its project is moving',
  areaBalance: 'Whether that part of your life needs attention',
  effortFit: 'Whether it fits the time you have',
  staleness: 'How long it’s been waiting',
};

/**
 * The eight retention windows, in the order §11's table lists them.
 *
 * Archive rules first, prune rules second, and the copy says which is which on
 * every row — because the difference is the entire promise the product makes
 * about your data. Nothing a human wrote is ever deleted by a clock: thoughts,
 * tasks, projects, goals and reviews are *hidden* and stay restorable for ever.
 * Only derived and log data is removed, and none of it is anything you typed.
 */
const RETENTION_WINDOWS: ReadonlyArray<{
  key: string;
  label: string;
  action: 'archive' | 'prune';
  help: string;
}> = [
  {
    key: 'inboxThoughtDays',
    label: 'Notes left in the inbox',
    action: 'archive',
    help: 'A note you captured and never did anything with. Archived, not deleted — it stays findable by wording and comes back with one click.',
  },
  {
    key: 'completedTaskDays',
    label: 'Tasks you finished',
    action: 'archive',
    help: 'Measured from when you completed it, not when you created it.',
  },
  {
    key: 'closedProjectDays',
    label: 'Projects you closed',
    action: 'archive',
    help: 'Their remaining tasks are archived with them, so a finished project stops putting work in front of you.',
  },
  {
    key: 'reviewDays',
    label: 'Generated reviews and briefings',
    action: 'archive',
    help: 'The written output of the background workflows. Two years keeps every review period answerable.',
  },
  {
    key: 'staleEntityDays',
    label: 'People and companies gone quiet',
    action: 'prune',
    help: 'This one only decides when they appear in the Archive page’s “gone quiet” list. A person is never archived automatically, whatever this says — a dormant client is not a dead one.',
  },
  {
    key: 'suggestedLinkDays',
    label: 'Connection suggestions nobody looked at',
    action: 'prune',
    help: 'Deleted, because they are regenerated from your notes whenever the pair still looks related. A connection you actively rejected is kept for ever — that is what stops it being suggested again.',
  },
  {
    key: 'eventDays',
    label: 'Activity log',
    action: 'prune',
    help: 'What moved and when. This is what “what did you finish this week” reads, so a rolling window longer than a year keeps every review period answerable.',
  },
  {
    key: 'planTimeBlockDays',
    label: 'Past planned time blocks',
    action: 'prune',
    help: 'Time you blocked out and never used. Blocks recording what actually happened are never removed.',
  },
];

const WORK_STYLE_LABELS: Record<(typeof WORK_STYLES)[number], string> = {
  structured: 'Structured — lead with what’s overdue',
  balanced: 'Balanced',
  exploratory: 'Exploratory — surface connections and loose ends',
};

export interface SpaceSettings {
  timezone: string;
  weeklyCapacityMinutes: number;
  workStyle: string;
  priorityWeights: Record<string, number>;
  connectionStrengthFloor: number;
  /** The eight §11 windows, in days. Resolved defaults when never customised. */
  retentionPolicy: Record<string, number>;
}

const formSchema = z.object({
  timezone: z.string().trim().min(1, 'Pick a timezone'),
  weeklyCapacityHours: z
    .string()
    .refine((value) => Number.isFinite(Number(value)), 'Use a number')
    .refine((value) => Number(value) >= 0 && Number(value) <= 168, 'A week has 168 hours'),
  workStyle: z.enum(WORK_STYLES),
  weights: z.record(z.string(), z.number()),
  connectionStrengthFloor: z.number().min(0.2).max(0.95),
  /**
   * Windows in days. The upper bound is a century, matching the API schema —
   * "effectively never" is a legitimate answer and should be expressible without
   * a separate switch that would then have to mean something in the pass.
   */
  retention: z.record(
    z.string(),
    z.number().int('Whole days').min(1, 'At least a day').max(36_500, 'A century is the maximum')
  ),
});

type SettingsFormValues = z.infer<typeof formSchema>;

/** The zones most people are in, plus whatever they already have set. */
const COMMON_ZONES = [
  'UTC',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Paris',
  'Europe/Berlin',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Australia/Sydney',
  'Pacific/Auckland',
];

export function SpaceSettingsForm({ initial }: { initial: SpaceSettings }): React.ReactElement {
  const router = useRouter();
  const { state, message, run } = useSaveStatus();

  const form = useForm<SettingsFormValues>({
    resolver: zodResolver(formSchema),
    mode: 'onTouched',
    defaultValues: {
      timezone: initial.timezone,
      weeklyCapacityHours: String(initial.weeklyCapacityMinutes / MINUTES_PER_HOUR),
      // `workStyle` arrives as plain `string` — validate it against the enum the form
      // declares rather than asserting it. See CLAUDE.md: never `as` on external data.
      // `.catch` preserves the default-on-miss the cast relied on.
      workStyle: formSchema.shape.workStyle.catch('balanced').parse(initial.workStyle),
      weights: { ...initial.priorityWeights },
      connectionStrengthFloor: initial.connectionStrengthFloor,
      retention: { ...initial.retentionPolicy },
    },
  });

  const weights = form.watch('weights');
  const retention = form.watch('retention');
  const weightTotal = PRIORITY_FACTORS.reduce((sum, key) => sum + (weights[key] ?? 0), 0);
  // A small epsilon absorbs float representation, exactly as the API schema does.
  const weightsValid = Math.abs(weightTotal - 1) < 1e-6;

  const zones = COMMON_ZONES.includes(initial.timezone)
    ? COMMON_ZONES
    : [initial.timezone, ...COMMON_ZONES];

  const onSubmit = form.handleSubmit(async (values) => {
    if (!weightsValid) return;

    const ok = await run(() =>
      apiClient.patch(OBSIDDY_API.SPACE, {
        body: {
          timezone: values.timezone,
          weeklyCapacityMinutes: Math.round(Number(values.weeklyCapacityHours) * MINUTES_PER_HOUR),
          workStyle: values.workStyle,
          priorityWeights: Object.fromEntries(
            PRIORITY_FACTORS.map((key) => [key, values.weights[key] ?? 0])
          ),
          connectionStrengthFloor: values.connectionStrengthFloor,
          retentionPolicy: Object.fromEntries(
            RETENTION_WINDOWS.map((window) => [window.key, values.retention[window.key] ?? 0])
          ),
        },
      })
    );

    if (ok) router.refresh();
  });

  return (
    <form className="space-y-6" onSubmit={(event) => void onSubmit(event)} noValidate>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Your week</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="settings-timezone" className="flex items-center gap-1.5">
              Timezone
              <FieldHelp title="Timezone">
                <p>
                  Everything scheduled resolves here, not on the server. &ldquo;Tomorrow
                  morning&rdquo; means 9am <em>your</em> time, from this page, your phone and the
                  agent alike.
                </p>
                <p>
                  Worth setting even if you never change anything else: the default is UTC, and a
                  task that comes back at 2am is not a task you deal with.
                </p>
              </FieldHelp>
            </Label>
            <Select
              value={form.watch('timezone')}
              onValueChange={(value) => form.setValue('timezone', value, { shouldTouch: true })}
            >
              <SelectTrigger id="settings-timezone">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {zones.map((zone) => (
                  <SelectItem key={zone} value={zone}>
                    {zone}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="settings-capacity" className="flex items-center gap-1.5">
              Hours a week you actually have
              <FieldHelp title="Weekly capacity">
                <p>
                  Compared against the time you block out, so Today can tell you how full your week
                  already is.
                </p>
                <p>
                  Real hours, not contracted ones — the number is only useful if it is the amount
                  you can genuinely spend.
                </p>
              </FieldHelp>
            </Label>
            <Input
              id="settings-capacity"
              type="number"
              min={0}
              max={168}
              step={0.5}
              {...form.register('weeklyCapacityHours')}
            />
            {form.formState.errors.weeklyCapacityHours && (
              <p className="text-destructive text-xs">
                {form.formState.errors.weeklyCapacityHours.message}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="settings-workstyle">How you like to work</Label>
            <Select
              value={form.watch('workStyle')}
              onValueChange={(value) =>
                form.setValue('workStyle', value as SettingsFormValues['workStyle'], {
                  shouldTouch: true,
                })
              }
            >
              <SelectTrigger id="settings-workstyle">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WORK_STYLES.map((style) => (
                  <SelectItem key={style} value={style}>
                    {WORK_STYLE_LABELS[style]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              Changes what the morning briefing picks out, not how your tasks are ranked. It takes
              effect on tomorrow&rsquo;s briefing; today&rsquo;s was already written overnight.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            What matters when ranking
            <FieldHelp title="Ranking weights">
              <p>
                Every task gets a score from these six things, weighted. Raise one and everything it
                applies to moves up.
              </p>
              <p>
                They have to add up to 1. That is what keeps a score inside a known range — and what
                makes pinning a task reliably put it first, rather than usually.
              </p>
            </FieldHelp>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {PRIORITY_FACTORS.map((factor) => (
            <div key={factor} className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor={`weight-${factor}`} className="text-sm font-normal">
                  {FACTOR_LABELS[factor]}
                </Label>
                <span className="text-muted-foreground w-12 text-right text-xs">
                  {Math.round((weights[factor] ?? 0) * 100)}%
                </span>
              </div>
              <Input
                id={`weight-${factor}`}
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={weights[factor] ?? 0}
                onChange={(event) =>
                  form.setValue(
                    'weights',
                    { ...weights, [factor]: Number(event.target.value) },
                    { shouldTouch: true }
                  )
                }
              />
            </div>
          ))}

          <p
            className={cn('text-xs', weightsValid ? 'text-muted-foreground' : 'text-destructive')}
            // Announced, because the submit button's disabled state is the only
            // other signal and that is invisible to a screen reader mid-edit.
            aria-live="polite"
          >
            {weightsValid
              ? 'Adds up to 100% — good.'
              : `Adds up to ${Math.round(weightTotal * 100)}%. It needs to be exactly 100% before this can be saved.`}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            How long things stick around
            <FieldHelp title="Retention">
              <p>
                <strong>Nothing you wrote is ever deleted by a clock.</strong> Notes, tasks,
                projects, goals and reviews are <em>archived</em> when they age out — hidden from
                every list, search and prompt, still readable, and restorable with one click, for
                ever.
              </p>
              <p>
                Only workings-out are deleted: connection suggestions nobody looked at, the activity
                log past its window, and planned time blocks that never happened. None of it is
                anything you typed.
              </p>
              <p>
                Archiving is also what keeps meaning-search sharp. An archived note leaves the
                index, so recall does not degrade as your history grows.
              </p>
            </FieldHelp>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {RETENTION_WINDOWS.map((window) => (
            <div key={window.key} className="space-y-1.5">
              <Label
                htmlFor={`retention-${window.key}`}
                className="flex items-center gap-1.5 font-normal"
              >
                {window.label}
                <FieldHelp title={window.label}>
                  <p>{window.help}</p>
                  <p>
                    {window.action === 'archive'
                      ? 'Archived — hidden, kept, reversible.'
                      : 'Deleted — this is derived data, not something you wrote.'}
                  </p>
                </FieldHelp>
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id={`retention-${window.key}`}
                  type="number"
                  min={1}
                  max={36_500}
                  className="w-28"
                  value={retention[window.key] ?? ''}
                  onChange={(event) =>
                    form.setValue(
                      'retention',
                      { ...retention, [window.key]: Number(event.target.value) },
                      { shouldTouch: true, shouldValidate: true }
                    )
                  }
                />
                <span className="text-muted-foreground text-xs">
                  days, then{' '}
                  {window.action === 'archive' ? (
                    <span className="font-medium">archived</span>
                  ) : (
                    <span className="font-medium">deleted</span>
                  )}
                </span>
              </div>
            </div>
          ))}

          {form.formState.errors.retention ? (
            <p className="text-destructive text-xs" aria-live="polite">
              Every window needs a whole number of days, between 1 and 36,500.
            </p>
          ) : null}

          <p className="text-muted-foreground text-xs">
            <Link href={OBSIDDY_ROUTES.ARCHIVE} className="underline underline-offset-2">
              See what is archived
            </Link>{' '}
            — and what has gone quiet and might want a decision.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Finding connections</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="settings-floor" className="flex items-center gap-1.5 font-normal">
              How similar is similar enough
              <FieldHelp title="Connection sensitivity">
                <p>
                  How alike two things must be before the system suggests they are related. Lower
                  finds more and is noisier; higher finds less and is surer.
                </p>
                <p>
                  The right value depends on the embedding model you are running. Set it too high
                  and you get no suggestions at all — which looks exactly like having nothing left
                  to find.
                </p>
              </FieldHelp>
            </Label>
            <span className="text-muted-foreground w-12 text-right text-xs">
              {form.watch('connectionStrengthFloor').toFixed(2)}
            </span>
          </div>
          <Input
            id="settings-floor"
            type="range"
            min={0.2}
            max={0.95}
            step={0.01}
            value={form.watch('connectionStrengthFloor')}
            onChange={(event) =>
              form.setValue('connectionStrengthFloor', Number(event.target.value), {
                shouldTouch: true,
              })
            }
          />
          <p className="text-muted-foreground text-xs">
            0.55 is the measured default for the standard model. Changing this affects future
            sweeps, not suggestions you already have.
          </p>
        </CardContent>
      </Card>

      {state === 'error' && message && <FormError message={message} />}

      <div className="flex items-center justify-between gap-2">
        <SaveStatus state={state} message={state === 'error' ? null : message} />
        <Button type="submit" disabled={state === 'saving' || !weightsValid}>
          Save settings
        </Button>
      </div>
    </form>
  );
}
