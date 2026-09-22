/**
 * `CLEAR` — no meaningful match against the configured list.
 * `POTENTIAL_MATCH` — a fuzzy match below the "certain" confidence
 * threshold. Common names produce these routinely; this is a visibility
 * flag for a human to resolve (`PATCH .../sanctions-review`), never an
 * automatic block.
 * `HIT` — a high-confidence match. Unlike every other status this port
 * can return, a `HIT` is meant to block the caller's action outright —
 * see `MerchantService.createMerchant()`/`submitKyc()`, the only two
 * callers of `screen()`.
 */
export type SanctionsScreeningStatus = 'CLEAR' | 'POTENTIAL_MATCH' | 'HIT';

export interface SanctionsScreeningResult {
  status: SanctionsScreeningStatus;
  /** The matched list entry's display name, only set for POTENTIAL_MATCH/HIT — human-readable evidence for a reviewer, not a stable identifier. */
  matchedListEntry?: string;
  /** 0-1 fuzzy match confidence, only set for POTENTIAL_MATCH/HIT. Exact matches (HIT) are always 1. */
  score?: number;
}

/**
 * Sanctions/Watchlist Screening Port (Outbound)
 * Answers a genuinely different question from `KYCProviderPort.verify()`:
 * not "is this business who it says it is," but "is this business (or
 * the individual behind it) on a list this platform is legally required
 * to refuse to do business with at all." See
 * docs/business-domain/compliance-and-security.md#sanctionswatchlist-screening-who-this-platform-is-legally-required-to-refuse
 * for why that's a distinct, prior question — screened at merchant
 * creation itself, not gated behind a downstream capability the way KYC
 * gates payouts.
 *
 * Two adapters — `MockSanctionsScreeningAdapter` (deterministic, fixture-
 * driven, local dev/test default) and `OfacSdnSanctionsAdapter` (matches
 * against the real, public US Treasury OFAC SDN list) — selected via
 * `SANCTIONS_PROVIDER` (`mock`/`ofac-self-hosted`) at DI-container build
 * time (`merchant.module.ts`'s `useFactory` binding), the same idiom
 * `KYCProviderPort`/`KYC_PROVIDER` already uses.
 */
export abstract class SanctionsScreeningPort {
  abstract screen(params: { name: string; taxId?: string; country?: string }): Promise<SanctionsScreeningResult>;
}
