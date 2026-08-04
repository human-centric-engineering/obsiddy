/**
 * Unit Tests: `obsiddy_notify`.
 *
 * This is the only Obsiddy capability that can send something out of the app,
 * which makes it the only one where a mistake is unrecoverable — an email
 * cannot be unsent, is copied through mail servers, and sits in an inbox
 * outside every erasure guarantee the tier makes.
 *
 * The design that follows from that is a closed set: the model picks one of five
 * notifications and may pass a bare integer, and **every word a recipient reads
 * is rendered server-side**. So the tests here are mostly about what the
 * capability *cannot* be made to do:
 *
 * - It cannot address anyone but the scope owner (no recipient argument exists,
 *   and the address is looked up from the scope).
 * - It cannot put attacker- or model-chosen text into an email (no subject or
 *   body argument exists, and the schema is `.strict()`).
 * - It cannot leak the user's own content, because nothing it sends is drawn
 *   from their rows.
 *
 * The remaining cluster is failure behaviour. A notification is the *last* step
 * of a workflow that has already written something useful, so neither a missing
 * account nor a bounced send may fail the run — the briefing is readable in the
 * app either way, and a workflow marked FAILED over an email is a false alarm
 * that trains people to ignore real ones.
 *
 * Test Coverage:
 * - The recipient is the scope owner's address, looked up at send time
 * - Every notification kind renders a subject and a body with an absolute link
 * - No user content appears in any rendered message
 * - `count` pluralises, and its absence degrades to wording that needs no number
 * - An erased owner is skipped with `no_owner`, and nothing is sent
 * - A failed send reports `send_failed` rather than throwing
 * - The schema rejects a recipient, a subject, a body, and an unknown kind
 * - Provenance keeps the args whole — there is nothing in them to redact
 *
 * @see lib/framework/obsiddy/capabilities/notify.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/framework/obsiddy/repo/owner-contact', () => ({ findOwnerContact: vi.fn() }));
vi.mock('@/lib/email/send', () => ({ sendEmail: vi.fn() }));

import {
  ObsiddyNotifyCapability,
  renderObsiddyNotification,
} from '@/lib/framework/obsiddy/capabilities/notify';
import { findOwnerContact } from '@/lib/framework/obsiddy/repo/owner-contact';
import { sendEmail } from '@/lib/email/send';
import { OBSIDDY_NOTIFICATIONS } from '@/lib/framework/obsiddy/validations';
import type { CapabilityContext } from '@/lib/orchestration/capabilities/types';

const mockedContact = vi.mocked(findOwnerContact);
const mockedSend = vi.mocked(sendEmail);

const CONTEXT: CapabilityContext = { userId: 'user_a', agentId: 'workflow:wf_1' };

function capability() {
  return new ObsiddyNotifyCapability();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedContact.mockResolvedValue({ email: 'owner@example.com', name: 'Owner' });
  mockedSend.mockResolvedValue({ success: true } as never);
});

describe('obsiddy_notify — what it sends', () => {
  it('addresses the scope owner, resolved at send time', async () => {
    const cap = capability();

    await cap.execute(cap.validate({ notification: 'briefing_ready' }), CONTEXT);

    expect(mockedContact).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user_a' }));
    expect(mockedSend.mock.calls[0]?.[0].to).toBe('owner@example.com');
  });

  it('sends for every notification kind, with a subject', async () => {
    for (const kind of OBSIDDY_NOTIFICATIONS) {
      vi.clearAllMocks();
      mockedContact.mockResolvedValue({ email: 'owner@example.com', name: 'Owner' });
      mockedSend.mockResolvedValue({ success: true } as never);

      const cap = capability();
      const result = await cap.execute(cap.validate({ notification: kind }), CONTEXT);

      expect(result.success, kind).toBe(true);
      expect(mockedSend.mock.calls[0]?.[0].subject, kind).toBeTruthy();
    }
  });

  it.each(OBSIDDY_NOTIFICATIONS)('renders %s as a subject plus an absolute link', (kind) => {
    const { subject, body } = renderObsiddyNotification(kind);

    expect(subject).toBeTruthy();
    expect(body).toMatch(/https?:\/\/\S+\/obsiddy/);
  });

  it('pluralises a count, and words the message without one when absent', () => {
    expect(renderObsiddyNotification('connections_found', 1).body).toContain(
      '1 new connection to review'
    );
    expect(renderObsiddyNotification('connections_found', 4).body).toContain(
      '4 new connections to review'
    );
    expect(renderObsiddyNotification('connections_found').body).toContain(
      'new connections waiting'
    );
  });

  it('renders plain text — the template has no Markdown parser', () => {
    for (const kind of OBSIDDY_NOTIFICATIONS) {
      const { body } = renderObsiddyNotification(kind, 3);

      expect(body, kind).not.toMatch(/^#{1,6}\s/m);
      expect(body, kind).not.toMatch(/\*\*/);
      expect(body, kind).not.toMatch(/\[.+\]\(.+\)/); // a Markdown link would render literally
    }
  });

  /**
   * The property the whole design exists for: nothing a recipient reads comes
   * from the user's rows. If a future edit interpolated a task title or a
   * briefing body into one of these messages, this is what should catch it.
   */
  it('renders no user content — every message is fixed wording plus a link', () => {
    for (const kind of OBSIDDY_NOTIFICATIONS) {
      const { subject, body } = renderObsiddyNotification(kind, 7);
      const linkless = body.replace(/https?:\/\/\S+/g, '');

      // Only the count may vary, and it is an integer.
      expect(`${subject} ${linkless}`.replace(/\b7\b/g, ''), kind).not.toMatch(/\d{2,}/);
    }
  });
});

describe('obsiddy_notify — what it cannot be made to do', () => {
  it('rejects a recipient, a subject or a body outright', async () => {
    const cap = capability();

    for (const injected of [
      { notification: 'briefing_ready', to: 'attacker@evil.test' },
      { notification: 'briefing_ready', subject: 'Your account needs attention' },
      { notification: 'briefing_ready', body: 'Click here to verify' },
    ]) {
      expect(() => cap.validate(injected)).toThrow();
    }
  });

  it('rejects a notification kind outside the closed set', () => {
    const cap = capability();

    expect(() => cap.validate({ notification: 'password_reset' })).toThrow();
  });

  it('refuses an ownerless run before reaching the mailer', async () => {
    const cap = capability();

    const result = await cap.execute(cap.validate({ notification: 'briefing_ready' }), {
      userId: null,
      agentId: 'workflow:wf_1',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('no_user_context');
    expect(mockedContact).not.toHaveBeenCalled();
    expect(mockedSend).not.toHaveBeenCalled();
  });
});

describe('obsiddy_notify — failure behaviour', () => {
  it('skips quietly when the account is gone, sending nothing', async () => {
    // The orphaned-schedule case: AiWorkflowSchedule.createdBy is SetNull, so a
    // deleted user's schedule can still fire.
    mockedContact.mockResolvedValue(null);
    const cap = capability();

    const result = await cap.execute(cap.validate({ notification: 'briefing_ready' }), CONTEXT);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ sent: false, reason: 'no_owner' });
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('reports a failed send rather than throwing — the briefing is readable regardless', async () => {
    mockedSend.mockResolvedValue({ success: false, error: 'smtp down' } as never);
    const cap = capability();

    const result = await cap.execute(cap.validate({ notification: 'briefing_ready' }), CONTEXT);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ sent: false, reason: 'send_failed' });
  });
});

describe('obsiddy_notify — provenance', () => {
  it('keeps the arguments whole, because there is no free text in them', async () => {
    const cap = capability();
    const args = cap.validate({ notification: 'connections_found', count: 3 });

    const redaction = cap.redactProvenance(args, { success: true, data: { sent: true } });

    expect(redaction.args).toEqual({ notification: 'connections_found', count: 3 });
    expect(redaction.resultPreview).toContain('sent');
  });
});
