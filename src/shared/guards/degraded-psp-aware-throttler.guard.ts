import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ThrottlerModuleOptions,
  ThrottlerStorage,
  ThrottlerRequest,
  InjectThrottlerOptions,
  InjectThrottlerStorage,
} from '@nestjs/throttler';
import { MerchantThrottlerGuard } from './merchant-throttler.guard';
import { MerchantPspExposureService } from '../../modules/payment/adapters/circuit-breaker/merchant-psp-exposure.service';

// A stricter ceiling applied only when a merchant's recent charges are
// concentrated on a currently-degraded PSP (see
// MerchantPspExposureService.isExposedToDegradedPsp()). Default is well
// under CHARGE_RATE_LIMIT_MAX's own 100/min default — deliberately, since
// the point is to slow this specific merchant's hammering of a struggling
// PSP, not to match their normal-conditions throughput.
const DEGRADED_MERCHANT_CHARGE_RATE_LIMIT_MAX =
  Number(process.env.DEGRADED_MERCHANT_CHARGE_RATE_LIMIT_MAX) || 20;

const REGISTERED_PROVIDERS = ['STRIPE', 'ADYEN'];

/**
 * Extends MerchantThrottlerGuard with one extra behavior, scoped only to
 * the charge endpoint: if a merchant's recent charges have been
 * concentrated on a currently-degraded PSP, apply a stricter limit to
 * their next charge attempt too.
 *
 * Deliberately protects the merchant's own throughput, not the platform's
 * overall load — a merchant whose traffic is landing on a healthy PSP
 * (including via automatic fallback) is never throttled by this, even
 * while some *other* PSP is degraded. See
 * docs/spec/future/distributed-resilience-and-cde-isolation.md for the
 * design rationale (including why this option was chosen over a
 * platform-wide slowdown).
 */
@Injectable()
export class DegradedPspAwareThrottlerGuard extends MerchantThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly exposureService: MerchantPspExposureService,
  ) {
    super(options, storageService, reflector);
  }

  protected async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    // Scoped to the charge handler specifically — every other route this
    // guard also covers (read, refund, capture, cancel, subscriptions,
    // plans, delegations) doesn't newly attempt to reach a PSP the way a
    // charge does, so the normal fixed limit stays correct for them.
    if (requestProps.context.getHandler().name === 'charge') {
      const req = requestProps.context.switchToHttp().getRequest();
      const merchantId = req.user?.merchantId;
      if (merchantId) {
        const exposed = await this.exposureService.isExposedToDegradedPsp(merchantId, REGISTERED_PROVIDERS);
        if (exposed) {
          requestProps = { ...requestProps, limit: DEGRADED_MERCHANT_CHARGE_RATE_LIMIT_MAX };
        }
      }
    }

    return super.handleRequest(requestProps);
  }
}
