import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PSPProvider } from '../../domain/aggregates/payment.aggregate';

export interface PspFeeSchedule {
  feePercentage: number;
  fixedFeeMinorUnits: number;
}

/**
 * Single source of truth for the PSP fee numbers used in two different
 * places that used to each hardcode their own copy:
 * StripePSPAdapter/AdyenPSPAdapter's getHealthStatus() (smart-routing's
 * cost estimate, driving which PSP looks cheaper) and
 * PspCostReconciliationService (comparing that estimate against what a
 * PSP actually invoiced). Configurable per-deployment
 * (STRIPE_FEE_PERCENTAGE/STRIPE_FIXED_FEE_MINOR_UNITS/
 * ADYEN_FEE_PERCENTAGE/ADYEN_FIXED_FEE_MINOR_UNITS) rather than hardcoded
 * — that makes the *routing estimate* accurate to whatever this
 * deployment's real negotiated rate is, not "calibrated" in the sense of
 * being reconciled against real invoices; see
 * PspCostReconciliationService's own docblock for the piece that
 * actually closes that gap.
 */
@Injectable()
export class PspFeeScheduleService {
  // Partial, not Record<PSPProvider, ...> — 'PAYPAL'/'CHASE' are valid
  // PSPProvider values (the type exists for future routing options) but
  // have no adapter implementation yet, so there's nothing real to
  // configure a fee schedule for.
  private readonly schedules: Partial<Record<PSPProvider, PspFeeSchedule>>;

  constructor(configService: ConfigService) {
    // `ConfigService.get<number>()` doesn't actually cast (see
    // health.controller.ts's own comment on the same gap) — wrap
    // explicitly. Defaults match the numbers this codebase always
    // hardcoded (Stripe's standard US card rate; Adyen's interchange++
    // model, illustrative — see AdyenPSPAdapter's own prior comment).
    this.schedules = {
      STRIPE: {
        feePercentage: Number(configService.get('STRIPE_FEE_PERCENTAGE', 2.9)),
        fixedFeeMinorUnits: Number(configService.get('STRIPE_FIXED_FEE_MINOR_UNITS', 30)),
      },
      ADYEN: {
        feePercentage: Number(configService.get('ADYEN_FEE_PERCENTAGE', 0.3)),
        fixedFeeMinorUnits: Number(configService.get('ADYEN_FIXED_FEE_MINOR_UNITS', 10)),
      },
    };
  }

  getSchedule(provider: PSPProvider): PspFeeSchedule {
    const schedule = this.schedules[provider];
    if (!schedule) {
      throw new Error(`No PSP fee schedule configured for provider '${provider}'`);
    }
    return schedule;
  }
}
