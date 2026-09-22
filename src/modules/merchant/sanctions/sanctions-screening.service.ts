import { Injectable } from '@nestjs/common';
import { SanctionsScreeningPort, SanctionsScreeningStatus } from '../sanctions-screening.port';

export interface SanctionsScreeningOutcome {
  status: SanctionsScreeningStatus;
  confidence: 'FULL' | 'DEGRADED';
  matchedListEntry?: string;
  score?: number;
}

/**
 * Sanctions Screening Service — the pure "decide the outcome" half of
 * sanctions screening, deliberately kept free of any `MerchantService`
 * dependency. `MerchantService.createMerchant()`/`submitKyc()` need to
 * call this (a merchant's identity is only ever known at the point
 * those two methods run), and if this service depended on
 * `MerchantService` in turn — the way `SanctionsNotificationDispatcherService`
 * legitimately does, since it looks a merchant back up to read its
 * notification config — that would be a circular dependency. Applying
 * the outcome to `MerchantEntity` and deciding whether to notify both
 * stay the caller's job (`MerchantService`, `SanctionsScreeningSweepService`).
 *
 * Falls back to a display name at *degraded* confidence when no legal
 * name is available yet — see
 * docs/business-domain/merchants.md#step-1--identity-capture-and-sanctions-screening-at-creation
 * for why that distinction is tracked rather than treated as equivalent
 * to a real legal name.
 */
@Injectable()
export class SanctionsScreeningService {
  constructor(private readonly sanctionsPort: SanctionsScreeningPort) {}

  async screen(params: {
    legalName?: string | null;
    displayName: string;
    taxId?: string | null;
  }): Promise<SanctionsScreeningOutcome> {
    const usingLegalName = !!params.legalName;
    const nameToScreen = params.legalName ?? params.displayName;
    const result = await this.sanctionsPort.screen({
      name: nameToScreen,
      ...(params.taxId ? { taxId: params.taxId } : {}),
    });
    return {
      status: result.status,
      confidence: usingLegalName ? 'FULL' : 'DEGRADED',
      matchedListEntry: result.matchedListEntry,
      score: result.score,
    };
  }

  /** Human-readable evidence for a reviewer — null for CLEAR (nothing matched). */
  formatMatchDetails(matchedListEntry?: string, score?: number): string | null {
    if (!matchedListEntry) return null;
    return `${matchedListEntry} (score=${score !== undefined ? score.toFixed(3) : 'n/a'})`;
  }
}
