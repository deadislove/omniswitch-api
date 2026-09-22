import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SanctionsListStore, SanctionsListEntry } from './sanctions-list.store';
import { normalizeName } from './jaro-winkler';

// The real Treasury SDN.CSV format has no header row; column 1 (0-indexed)
// is SDN_Name. See https://www.treasury.gov/ofac/downloads/sdn.csv —
// referenced here as documentation of the shape this parser targets, not
// fetched by any test (this repo has never called it with real network
// egress — see this class's own docblock).
const SDN_NAME_COLUMN_INDEX = 1;

/** A minimal, quote-aware CSV row splitter — handles the SDN.CSV convention of double-quoted fields that may themselves contain commas. Not a general-purpose CSV parser (no escaped-quote-within-quote handling), which the real SDN.CSV format doesn't use. */
function splitCsvRow(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current.trim());
  return fields;
}

function parseSdnCsv(csv: string): SanctionsListEntry[] {
  const entries: SanctionsListEntry[] = [];
  for (const line of csv.split('\n')) {
    if (!line.trim()) continue;
    const fields = splitCsvRow(line);
    const name = fields[SDN_NAME_COLUMN_INDEX];
    if (!name || name === '-0-') continue;
    entries.push({ displayName: name, normalizedName: normalizeName(name) });
  }
  return entries;
}

/**
 * Sanctions List Refresh Service
 * Keeps `SanctionsListStore` current — OFAC updates the real SDN list
 * several times a week, so screening against a list fetched once at
 * deploy time would silently go stale. Fetches from
 * `SANCTIONS_LIST_SOURCE_URL` (the official Treasury CSV endpoint, when
 * configured) weekly (`CronExpression.EVERY_WEEK` — same fixed-schedule
 * idiom every other sweep in this codebase uses, e.g. `RiskTieringService`,
 * not a bespoke configurable cron string) and on demand (`refresh()`,
 * callable from a startup hook or an admin endpoint).
 *
 * Requires outbound network egress from wherever this service runs — not
 * every deployment environment allows that by default. When
 * `SANCTIONS_LIST_SOURCE_URL` is unset, or a fetch fails, this leaves
 * `SanctionsListStore`'s current contents untouched (the bundled
 * snapshot, if no refresh has ever succeeded) — enough to exercise real
 * matching logic with no internet egress at all (local dev, CI, an
 * air-gapped deployment), but not a substitute for a live refresh in
 * production. See docs/technical/security-and-compliance.md's Sanctions/
 * Watchlist Screening section for the full honesty note: this parser
 * targets the real, documented SDN.CSV column shape, but no environment
 * this codebase has run in has ever actually fetched it over a real
 * network connection.
 */
@Injectable()
export class SanctionsListRefreshService {
  private readonly logger = new Logger(SanctionsListRefreshService.name);
  private readonly sourceUrl: string | undefined;

  constructor(
    private readonly listStore: SanctionsListStore,
    configService: ConfigService,
  ) {
    this.sourceUrl = configService.get<string>('SANCTIONS_LIST_SOURCE_URL');
  }

  @Cron(CronExpression.EVERY_WEEK, { name: 'sanctions-list-refresh' })
  async refresh(): Promise<{ refreshed: boolean; entryCount?: number }> {
    if (!this.sourceUrl) {
      this.logger.debug('SANCTIONS_LIST_SOURCE_URL not configured — keeping current in-memory list as-is');
      return { refreshed: false };
    }

    try {
      const response = await fetch(this.sourceUrl, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const csv = await response.text();
      const entries = parseSdnCsv(csv);
      if (entries.length === 0) {
        throw new Error('parsed 0 entries — refusing to replace the current list with an empty one');
      }
      this.listStore.setEntries(entries);
      return { refreshed: true, entryCount: entries.length };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Sanctions list refresh from ${this.sourceUrl} failed (keeping current list): ${msg}`);
      return { refreshed: false };
    }
  }
}
