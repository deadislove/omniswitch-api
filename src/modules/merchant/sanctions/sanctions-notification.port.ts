import { SanctionsScreeningStatus } from '../sanctions-screening.port';

/**
 * `SanctionsNotificationDispatcherService`/adapters' payload shape —
 * fired for `POTENTIAL_MATCH`/`HIT` only, never `CLEAR`. Same "real
 * signal, per-merchant channel routing" shape
 * `AmlReviewNotificationPort` already established for its own event
 * family — see that port's docblock.
 */
export interface SanctionsNotificationPayload {
  event: 'sanctions_screening.flagged';
  merchantId: string;
  status: Extract<SanctionsScreeningStatus, 'POTENTIAL_MATCH' | 'HIT'>;
  matchedListEntry?: string;
  score?: number;
  /** Whether this screening ran against a real legalName (FULL) or fell back to the display name (DEGRADED) — see MerchantEntity.sanctionsScreeningConfidence's docblock. */
  confidence: 'FULL' | 'DEGRADED';
}

export abstract class SanctionsNotificationPort {
  abstract send(target: string, payload: SanctionsNotificationPayload): Promise<void>;
}
