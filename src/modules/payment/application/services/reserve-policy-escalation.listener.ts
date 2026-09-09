import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ReserveService } from './reserve.service';

/**
 * Reacts to `MerchantService.updateReservePolicy()`'s
 * `merchant.reserve_policy.escalated` event by topping up the
 * merchant's still-HELD reserve holds to the new rate — the same thing
 * `RiskTieringService`'s own automatic sweep escalation already does via
 * `ReserveService.topUpHeldReservesForMerchant()`. Lives here, not in
 * `MerchantModule`, because `MerchantModule` -> `PaymentModule` is the
 * wrong direction of this codebase's one-way module dependency (the
 * reverse already holds); an event crossing that boundary is the same
 * seam `DisputeNotificationListener`/`SubscriptionNotificationListener`
 * already use for their own cross-cutting reactions.
 */
@Injectable()
export class ReservePolicyEscalationListener {
  private readonly logger = new Logger(ReservePolicyEscalationListener.name);

  constructor(private readonly reserveService: ReserveService) {}

  @OnEvent('merchant.reserve_policy.escalated')
  async onReservePolicyEscalated(event: { merchantId: string; reserveBps: number }): Promise<void> {
    try {
      const { toppedUp, failed } = await this.reserveService.topUpHeldReservesForMerchant(
        event.merchantId,
        event.reserveBps,
      );
      if (toppedUp > 0 || failed > 0) {
        this.logger.log(
          `Manual reserve-policy escalation for merchant ${event.merchantId}: topped up ${toppedUp} still-HELD reserve hold(s) to ${event.reserveBps}bps, ${failed} failed`,
        );
      }
    } catch (err: unknown) {
      // Best-effort — a top-up failure must never surface back to the
      // admin's PATCH request (the reserve-policy change itself already
      // committed and returned successfully before this event fires).
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Reserve top-up failed for merchant ${event.merchantId}'s manual escalation: ${msg}`);
    }
  }
}
