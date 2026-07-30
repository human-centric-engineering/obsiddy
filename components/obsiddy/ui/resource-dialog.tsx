'use client';

/**
 * ResourceDialog — the create/edit shell the four resource forms share.
 *
 * Projects, goals, areas and entities all need the same thing: a dialog, a submit
 * that POSTs or PATCHes depending on whether there is an id, an error surface for
 * the failures Zod cannot predict, and a refresh on success. Writing that four
 * times is four places for the error handling to drift — and error handling is
 * exactly the part that gets copied badly.
 *
 * ## The caller owns `useForm`, and that is deliberate
 *
 * An earlier version took the Zod schema and built the form itself. It does not
 * type: `zodResolver` needs the schema's input and output types to line up with the
 * form's field values, and a component generic over "some Zod schema" loses that
 * relationship — the errors are unfixable without an `as`, which is the one thing
 * this codebase does not do to make types quiet.
 *
 * So the form instance comes in fully typed from a caller that knows its own
 * fields, and the shell handles the parts that are genuinely identical.
 *
 * ## `toBody` stays per-form
 *
 * The API schemas are `.strict()`, so "omit the field" and "send null" are
 * different requests: one leaves a value alone, the other clears it. Only the form
 * knows which one an empty input means, so a generic serialiser here would have to
 * guess — and guessing wrong silently wipes data on edit.
 *
 * `mode: 'onTouched'` per `CLAUDE.md` — callers set it; validating on every
 * keystroke shouts at someone halfway through their first word.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import type { FieldValues, UseFormReturn } from 'react-hook-form';

import { FormError } from '@/components/forms/form-error';
import { SaveStatus, useSaveStatus } from '@/components/obsiddy/ui/save-status';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { apiClient } from '@/lib/api/client';
import { OBSIDDY_API } from '@/lib/framework/obsiddy/api/endpoints';

export interface ResourceDialogProps<TValues extends FieldValues> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** One of the `OBSIDDY_API` collection constants. */
  collection: string;
  /** Present for an edit, absent for a create. */
  id?: string;
  title: string;
  description?: string;
  form: UseFormReturn<TValues>;
  /** Form values → request body. Per-form; see the header note. */
  toBody: (values: TValues) => Record<string, unknown>;
  children: React.ReactNode;
  submitLabel?: string;
}

export function ResourceDialog<TValues extends FieldValues>({
  open,
  onOpenChange,
  collection,
  id,
  title,
  description,
  form,
  toBody,
  children,
  submitLabel,
}: ResourceDialogProps<TValues>): React.ReactElement {
  const router = useRouter();
  const { state, message, run } = useSaveStatus();

  const onSubmit = form.handleSubmit(async (values) => {
    const body = toBody(values);

    const ok = await run(() =>
      id
        ? apiClient.patch(OBSIDDY_API.itemPath(collection, id), { body })
        : apiClient.post(collection, { body })
    );

    if (ok) {
      onOpenChange(false);
      router.refresh();
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => void onSubmit(event)}
          // Native validation would fire before Zod and show browser-styled
          // bubbles that say less than our own messages.
          noValidate
        >
          {children}

          {/* The API's own message, for what Zod cannot predict — a slug collision,
              or a row archived while the dialog was open. */}
          {state === 'error' && message && <FormError message={message} />}

          <DialogFooter className="items-center gap-2 sm:justify-between">
            <SaveStatus state={state} message={state === 'error' ? null : message} />
            <Button type="submit" disabled={state === 'saving'}>
              {submitLabel ?? (id ? 'Save changes' : 'Create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
