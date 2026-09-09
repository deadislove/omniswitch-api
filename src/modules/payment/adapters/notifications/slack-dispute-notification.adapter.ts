import { Injectable, Logger } from '@nestjs/common';
import { DisputeNotificationPort, DisputeNotificationPayload } from '../../ports/outbound/dispute-notification.port';
import { postJsonNotification } from './notification-delivery.util';

/**
 * Slack Dispute Notification Adapter
 * `target` is a Slack Incoming Webhook URL (a merchant sets one up in
 * their own Slack workspace and pastes it into
 * `disputeNotificationTarget`) — no separate Slack API credential or
 * bot token needed, since an Incoming Webhook URL already *is* the
 * authenticated endpoint. Posts Slack's own `{text}` payload shape
 * directly; no signing, since Slack's webhook contract doesn't define
 * or check one (the secrecy of the URL itself is the access control).
 */
@Injectable()
export class SlackDisputeNotificationAdapter extends DisputeNotificationPort {
  private readonly logger = new Logger(SlackDisputeNotificationAdapter.name);

  async send(target: string, payload: DisputeNotificationPayload): Promise<void> {
    const text =
      payload.event === 'dispute.created'
        ? `:rotating_light: New dispute ${payload.disputeId} for payment ${payload.paymentId} — ${payload.amount} ${payload.currency}, reason: ${payload.reason ?? 'unknown'} (auto-decision: ${payload.autoDecision ?? 'n/a'})${payload.respondBy ? `, respond by ${payload.respondBy}` : ''}`
        : `Dispute ${payload.disputeId} for payment ${payload.paymentId} resolved: *${payload.outcome}* (${payload.amount} ${payload.currency})`;

    await postJsonNotification(target, { text });
    this.logger.log(
      `Slack dispute notification sent for merchant ${payload.merchantId}: ${payload.event} (${payload.disputeId})`,
    );
  }
}
