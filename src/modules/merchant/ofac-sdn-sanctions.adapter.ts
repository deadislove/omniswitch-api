import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SanctionsScreeningPort, SanctionsScreeningResult } from './sanctions-screening.port';
import { SanctionsListStore } from './sanctions/sanctions-list.store';
import { jaroWinklerSimilarity, normalizeName } from './sanctions/jaro-winkler';

const DEFAULT_MATCH_THRESHOLD = 0.92;

/**
 * OFAC SDN Sanctions Adapter
 * A real, self-hosted match against the US Treasury OFAC Specially
 * Designated Nationals (SDN) list — real, government-published data,
 * not a paid vendor's proprietary database. Chosen specifically so this
 * adapter is buildable and testable against genuine list data without
 * procuring a commercial screening contract; see
 * docs/technical/security-and-compliance.md#sanctionswatchlist-screening
 * for why a commercial provider (ComplyAdvantage, Refinitiv World-Check)
 * remains a valid future adapter behind this same port if a real
 * deployment wants broader PEP/adverse-media coverage this self-hosted
 * list doesn't cover.
 *
 * `SanctionsListStore` holds the currently-active list (refreshed by
 * `SanctionsListRefreshService`, or the bundled snapshot if a refresh
 * has never succeeded) — this adapter only does the matching, not the
 * fetching, so the two concerns (network I/O vs. comparison logic) stay
 * independently testable.
 *
 * Exact normalized-name matches are always `HIT` (score 1). Below that,
 * `SANCTIONS_MATCH_THRESHOLD` (default 0.92) separates `POTENTIAL_MATCH`
 * from `CLEAR` — see this codebase's own docs for why that threshold is
 * a deliberately simple, illustrative starting point, not a calibrated
 * figure a real deployment should trust without review.
 */
@Injectable()
export class OfacSdnSanctionsAdapter extends SanctionsScreeningPort {
  private readonly logger = new Logger(OfacSdnSanctionsAdapter.name);
  private readonly matchThreshold: number;

  constructor(
    private readonly listStore: SanctionsListStore,
    configService: ConfigService,
  ) {
    super();
    this.matchThreshold = Number(configService.get('SANCTIONS_MATCH_THRESHOLD', DEFAULT_MATCH_THRESHOLD));
  }

  async screen(params: { name: string; taxId?: string; country?: string }): Promise<SanctionsScreeningResult> {
    const normalized = normalizeName(params.name);
    const entries = this.listStore.getEntries();

    let best: { entry: (typeof entries)[number]; score: number } | null = null;
    for (const entry of entries) {
      const score = entry.normalizedName === normalized ? 1 : jaroWinklerSimilarity(normalized, entry.normalizedName);
      if (!best || score > best.score) {
        best = { entry, score };
      }
    }

    if (!best || best.score < this.matchThreshold) {
      return { status: 'CLEAR' };
    }

    const status = best.score === 1 ? 'HIT' : 'POTENTIAL_MATCH';
    this.logger.warn(
      `Sanctions screening for "${params.name}": ${status} (matched "${best.entry.displayName}", score=${best.score.toFixed(3)})`,
    );
    return { status, matchedListEntry: best.entry.displayName, score: best.score };
  }
}
