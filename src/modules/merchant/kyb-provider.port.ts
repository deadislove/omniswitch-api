/**
 * Same three-value vocabulary as `KYCVerificationStatus` — `PENDING` only
 * ever comes from a real, async-reviewing provider
 * (`PersonaKybProviderAdapter`), never the synchronous mock. See that
 * type's own docblock; this is KYB's structural mirror, not a
 * coincidence — most real providers (Persona, Middesk, Alloy) offer
 * business verification through the same or an adjacent API to identity
 * verification, so the shape this codebase already has for KYC extends
 * cleanly rather than needing a parallel design.
 */
export type KYBVerificationStatus = 'APPROVED' | 'REJECTED' | 'PENDING';

export interface KYBVerificationResult {
  status: KYBVerificationStatus;
  applicationId: string;
  reason?: string;
}

export interface BeneficialOwner {
  name: string;
  /** 0-100. Real UBO regulations (FinCEN's CDD Rule, EU AMLD) generally require identifying anyone at or above a 25% ownership threshold — not enforced here, just recorded. */
  ownershipPercentage: number;
}

/**
 * KYB (Know Your Business) Provider Port (Outbound)
 * Answers a different question from `KYCProviderPort`: not "is this
 * individual who they say they are," but "is this *business* real,
 * registered, and who actually owns/controls it." A marketplace
 * onboarding real businesses needs both — verifying an individual's
 * identity via KYC says nothing about whether the business itself is
 * legitimate or who its beneficial owners are. See
 * docs/business-domain/merchants.md#step-3--kyb-for-connected-merchants-only.
 *
 * Same two-adapter, `useFactory`-selected shape as `KYCProviderPort`
 * (`KYB_PROVIDER`, `mock`/`persona`) — see `merchant.module.ts`.
 */
export abstract class KYBProviderPort {
  abstract verify(params: {
    legalName: string;
    taxId: string;
    country: string;
    beneficialOwners?: BeneficialOwner[];
  }): Promise<KYBVerificationResult>;
}
