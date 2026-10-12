import { MatchReasonCode } from './match-reason-code';

export interface MatchReportResult {
  reportId: string;
  reportedAt: Date;
}

/**
 * MATCH Reporting Port (Outbound)
 * Models filing a terminated-for-cause merchant to Mastercard's MATCH
 * ("Member Alert To Control High-risk Merchants") system — the shared
 * industry file acquirers check before onboarding a new merchant, and
 * are themselves obligated to report into when they terminate one for
 * cause. See `MerchantService.terminateForCause()`, the only caller.
 *
 * Unlike `KYCProviderPort`/`SanctionsScreeningPort`, there is no free,
 * publicly-accessible real counterpart to stand up an alternate adapter
 * against — OFAC's SDN list is public data, but filing a real MATCH
 * report requires actual Mastercard acquirer-member network
 * credentials — so this port only ever has one adapter,
 * `MockMatchReportingAdapter`, regardless of environment.
 */
export abstract class MatchReportingPort {
  abstract report(params: {
    merchantId: string;
    legalName: string;
    reasonCode: MatchReasonCode;
    reason: string;
  }): Promise<MatchReportResult>;
}
