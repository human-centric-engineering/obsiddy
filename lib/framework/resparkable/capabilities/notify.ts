/**
 * `resparkable_notify` — tell the owner something is ready, and nothing more.
 *
 * ## This is the only capability that can reach outside the app, so it is the
 * most constrained one
 *
 * Every other Resparkable capability reads or writes rows that stay behind a
 * session. This one sends an email, which is durable, unrevocable, copied
 * through mail servers, and readable by anyone who later gets into the inbox. A
 * naive version takes `{ to, subject, body }` and is three separate problems:
 *
 *   1. **An exfiltration channel.** A model that can put arbitrary text in an
 *      email can move a brain out of the system a paragraph at a time, and
 *      prompt injection through a synced note or an inbound capture is a real
 *      path to making it do so.
 *   2. **Impersonation.** Attacker-chosen wording arriving from the product's
 *      own address is a phishing primitive with the user's trust attached.
 *   3. **Content sprawl.** Even used honestly, mailing the briefing copies goals
 *      and task titles somewhere the tier's erasure guarantees do not reach.
 *
 * So: **no recipient argument, no subject argument, no body argument.** The
 * model picks one of a closed set of notifications and, at most, supplies a
 * bare integer. Everything a recipient reads is rendered here. The model
 * decides *whether* to notify; it can never decide what the notification says.
 *
 * ## The address is resolved now, not stored
 *
 * `findOwnerContact` reads the `user` row at send time. A `null` means the
 * account is gone — which happens when an orphaned `AiWorkflowSchedule` fires
 * after erasure — and the correct response is to skip quietly rather than fail a
 * workflow over a notification nobody will receive.
 */

import { ResparkableCapability } from '@/lib/framework/resparkable/capabilities/base';
import {
  resparkableCapabilitySpec,
  RESPARKABLE_CAPABILITY_SLUGS,
} from '@/lib/framework/resparkable/capabilities/catalogue';
import { findOwnerContact } from '@/lib/framework/resparkable/repo/owner-contact';
import type { OwnerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import { RESPARKABLE_ROUTES } from '@/lib/framework/resparkable/ui/routes';
import { agentNotifySchema, type AgentNotifyInput } from '@/lib/framework/resparkable/validations';
import { sendEmail } from '@/lib/email/send';
import { env } from '@/lib/env';
import { logger } from '@/lib/logging';
import type { ProvenanceRedaction } from '@/lib/orchestration/capabilities/base-capability';
import type {
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';
import { WorkflowNotification } from '@/emails/workflow-notification';

const spec = resparkableCapabilitySpec(RESPARKABLE_CAPABILITY_SLUGS.notify);

type NotifyArgs = AgentNotifyInput;

export interface NotifyResult {
  sent: boolean;
  /** Why nothing was sent, when nothing was. */
  reason?: 'no_owner' | 'send_failed';
}

/**
 * The message for each notification, rendered server-side.
 *
 * Deliberately dull: one sentence, one link, no content. `count` is the only
 * caller-supplied value that reaches a recipient and it is an integer, so the
 * worst a compromised model can do is claim the wrong number of connections
 * were found.
 *
 * Plain text rather than Markdown, because `WorkflowNotification` renders its
 * body into a single `<Text>` — newlines survive, `##` does not.
 *
 * **Exported so it can be tested directly.** Everything a recipient reads is
 * decided here, so this is the function whose output matters; reaching it
 * through a React element handed to a mocked mailer would test the assertion
 * against React's internals rather than against the wording.
 */
export function renderResparkableNotification(
  notification: NotifyArgs['notification'],
  count?: number
): { subject: string; body: string } {
  const url = (path: string): string => `${env.NEXT_PUBLIC_APP_URL}${path}`;

  switch (notification) {
    case 'briefing_ready':
      return {
        subject: 'Your morning briefing is ready',
        body: `Your briefing for today is ready.\n\n${url(RESPARKABLE_ROUTES.TODAY)}`,
      };
    case 'daily_review_ready':
      return {
        subject: 'Your daily review is ready',
        body: `Last night's pass over your inbox is done.\n\n${url(RESPARKABLE_ROUTES.TODAY)}`,
      };
    case 'weekly_review_ready':
      return {
        subject: 'Your weekly review is ready',
        body: `Your review of the week is ready to read.\n\n${url(RESPARKABLE_ROUTES.TODAY)}`,
      };
    case 'horizon_check_ready':
      return {
        subject: 'Your monthly goal check is ready',
        body: `This month's look at your goals is ready.\n\n${url(RESPARKABLE_ROUTES.GOALS)}`,
      };
    case 'connections_found':
      return {
        subject: 'New connections to review',
        body:
          count === undefined
            ? `There are new connections waiting for you.\n\n${url(RESPARKABLE_ROUTES.CONNECTIONS)}`
            : `${count} new ${count === 1 ? 'connection' : 'connections'} to review.\n\n${url(RESPARKABLE_ROUTES.CONNECTIONS)}`,
      };
  }
}

export class ResparkableNotifyCapability extends ResparkableCapability<NotifyArgs, NotifyResult> {
  readonly slug = spec.slug;
  readonly functionDefinition: CapabilityFunctionDefinition = spec.functionDefinition;
  protected readonly schema = agentNotifySchema;

  /**
   * The one Resparkable capability whose arguments are safe to keep whole: a
   * closed-set enum and an integer, with no free text anywhere in it by
   * construction. The result is a boolean and a reason code.
   *
   * Keeping it verbatim is the point rather than an oversight — "which
   * notifications did this system send, and when" is exactly what an auditor
   * should be able to reconstruct, and there is nothing here to redact.
   */
  redactProvenance(args: NotifyArgs, result: CapabilityResult<NotifyResult>): ProvenanceRedaction {
    return { args, resultPreview: JSON.stringify(result.data ?? {}) };
  }

  protected async run(
    args: NotifyArgs,
    scope: OwnerScope
  ): Promise<CapabilityResult<NotifyResult>> {
    const contact = await findOwnerContact(scope);

    if (!contact) {
      // An erased account whose schedule row outlived it. Not an error: the
      // workflow did its job, there is simply nobody left to tell.
      logger.info('Resparkable notification skipped — no owner', {
        userId: scope.userId,
        notification: args.notification,
      });
      return this.success({ sent: false, reason: 'no_owner' });
    }

    const { subject, body } = renderResparkableNotification(args.notification, args.count);

    const result = await sendEmail({
      to: contact.email,
      subject,
      react: WorkflowNotification({ body, workflowName: 'Resparkable' }),
    });

    if (!result.success) {
      // Reported rather than thrown: a failed notification should not fail the
      // run that produced the thing being notified about. The briefing is
      // written and readable in the app either way.
      logger.warn('Resparkable notification failed to send', {
        userId: scope.userId,
        notification: args.notification,
      });
      return this.success({ sent: false, reason: 'send_failed' });
    }

    return this.success({ sent: true });
  }
}
