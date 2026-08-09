export interface KYCVerificationResult {
  approved: boolean;
  applicationId: string;
  reason?: string;
}

/**
 * KYC Provider Port (Outbound)
 * The identity/business verification a real marketplace can't skip before
 * letting a connected account receive payouts — see
 * docs/business-domain/ledger-and-settlement.md#connected-account-kyc.
 * Same "single external HTTP call" shape as FXRateProviderPort, not a
 * whole PSP-style multi-method interface — this system only ever asks a
 * KYC provider one thing: is this business who it says it is.
 */
export abstract class KYCProviderPort {
  abstract verify(params: { legalName: string; taxId: string }): Promise<KYCVerificationResult>;
}
