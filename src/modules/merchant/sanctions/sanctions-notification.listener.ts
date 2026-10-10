import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { SanctionsNotificationDispatcherService } from './sanctions-notification-dispatcher.service';
import { SanctionsNotificationPayload } from './sanctions-notification.port';

/**
 * Reacts to `MerchantService.createMerchant()`/`submitKyc()`'s
 * `merchant.sanctions_screening.flagged` event. Both live in the same
 * module (`MerchantModule`) as `SanctionsNotificationDispatcherService`
 * — unlike `ReservePolicyEscalationListener`, this isn't crossing a
 * module boundary, but the event indirection still earns its keep here:
 * `SanctionsNotificationDispatcherService` depends on `MerchantService`
 * (to read notification config), so `MerchantService` calling it
 * directly would be circular. Same fix, applied within one module
 * instead of across two.
 */
@Injectable()
export class SanctionsNotificationListener {
  private readonly logger = new Logger(SanctionsNotificationListener.name);

  constructor(private readonly dispatcher: SanctionsNotificationDispatcherService) {}

  @OnEvent('merchant.sanctions_screening.flagged')
  async onSanctionsScreeningFlagged(event: Omit<SanctionsNotificationPayload, 'event'>): Promise<void> {
    await this.dispatcher.notify({ event: 'sanctions_screening.flagged', ...event });
  }
}
