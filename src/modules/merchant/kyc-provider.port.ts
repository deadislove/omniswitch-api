/**
 * `APPROVED`/`REJECTED` — the provider reached a final decision, either
 * synchronously in this same call (`MockKYCProviderAdapter`) or via a
 * later async callback the caller must already know how to wait for
 * (`PersonaKycProviderAdapter`'s `PENDING` case below).
 * `PENDING` — the provider accepted the application for review but
 * hasn't decided yet; final outcome arrives later via
 * `POST /webhooks/kyc`, verified by `KycWebhookGuard`. Only
 * `PersonaKycProviderAdapter` returns this — a real identity/business
 * verification genuinely takes hours to days, sometimes involving a
 * human reviewer, never seconds.
 */
export type KYCVerificationStatus = 'APPROVED' | 'REJECTED' | 'PENDING';

export interface KYCVerificationResult {
  status: KYCVerificationStatus;
  applicationId: string;
  reason?: string;
}

/**
 * KYC Provider Port (Outbound)
 * The identity/business verification a real marketplace can't skip before
 * letting a connected account receive payouts — see
 * docs/business-domain/marketplace-and-payouts.md#connected-account-kyc.
 * Same "single external HTTP call" shape as `FXRateProviderPort`, not a
 * whole PSP-style multi-method interface — this system only ever asks a
 * KYC provider one thing: is this business who it says it is.
 *
 * Two adapters — `MockKYCProviderAdapter` (synchronous, local dev/test
 * default) and `PersonaKycProviderAdapter` (real, async — submits then
 * waits for a webhook) — selected via `KYC_PROVIDER` (`mock`/`persona`)
 * at DI-container build time (`merchant.module.ts`'s `useFactory`
 * binding), the same idiom `BankTransferPort` uses for
 * `BANK_TRANSFER_PROVIDER`.
 */
export abstract class KYCProviderPort {
  abstract verify(params: { legalName: string; taxId: string }): Promise<KYCVerificationResult>;
}
