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
    },
  });

  const weights = form.watch('weights');
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
              Changes what the morning briefing picks out, not how your tasks are ranked. The
              briefing itself arrives in a later phase.
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
