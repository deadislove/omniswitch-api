import { Injectable, Logger } from '@nestjs/common';
import { normalizeName } from './jaro-winkler';

export interface SanctionsListEntry {
  /** Normalized (see normalizeName()) — matching always compares normalized-to-normalized. */
  normalizedName: string;
  /** Original, human-readable form — surfaced to a reviewer, never used for matching itself. */
  displayName: string;
}

/**
 * A handful of real, long-public, historical US Treasury OFAC SDN
 * entries — genuine list data (not synthetic placeholders like "Test
 * Sanctioned Corp"), so `OfacSdnSanctionsAdapter`'s matching logic is
 * exercised against the same kind of name data a real feed would
 * contain. **Not a current, complete, or authoritative sanctions
 * list** — see docs/technical/security-and-compliance.md's Sanctions/
 * Watchlist Screening section for why this exists (an environment with
 * no outbound network egress, or `SANCTIONS_LIST_SOURCE_URL` unset,
 * still gets real matching behavior to test/develop against) and why a
 * real deployment must configure a live refresh instead of relying on
 * this snapshot.
 */
export const BUNDLED_SDN_SNAPSHOT: SanctionsListEntry[] = [
  { displayName: 'USAMA BIN LADIN', normalizedName: normalizeName('USAMA BIN LADIN') },
  { displayName: 'SADDAM HUSSEIN AL-TIKRITI', normalizedName: normalizeName('SADDAM HUSSEIN AL-TIKRITI') },
  { displayName: 'SLOBODAN MILOSEVIC', normalizedName: normalizeName('SLOBODAN MILOSEVIC') },
];

/**
 * Holds the currently-active sanctions list in memory —
 * `SanctionsListRefreshService` replaces its contents on a successful
 * fetch from `SANCTIONS_LIST_SOURCE_URL`; `OfacSdnSanctionsAdapter`
 * reads from it on every `screen()` call. A plain in-memory singleton,
 * not a database table — the list is re-fetched wholesale on refresh
 * (never partially updated), so there's no durability requirement a
 * restart-loses-it in-memory store doesn't already satisfy: a fresh
 * process just re-fetches (or falls back to the bundled snapshot) on
 * next startup, same as `mcc-risk-lookup.ts`'s static table has no
 * separate persistence layer either.
 */
@Injectable()
export class SanctionsListStore {
  private readonly logger = new Logger(SanctionsListStore.name);
  private entries: SanctionsListEntry[] = BUNDLED_SDN_SNAPSHOT;
  private lastRefreshedAt: Date | null = null;

  getEntries(): SanctionsListEntry[] {
    return this.entries;
  }

  getLastRefreshedAt(): Date | null {
    return this.lastRefreshedAt;
  }

  setEntries(entries: SanctionsListEntry[]): void {
    this.entries = entries;
    this.lastRefreshedAt = new Date();
    this.logger.log(`Sanctions list refreshed: ${entries.length} entries`);
  }
}
