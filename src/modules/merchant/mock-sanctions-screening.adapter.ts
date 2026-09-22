import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SanctionsScreeningPort, SanctionsScreeningResult } from './sanctions-screening.port';

/**
 * Mock Sanctions Screening Adapter
 * Calls scripts/mock-psp/server.js's `/sanctions/screen` endpoint — same
 * "point at a local mock in tests/dev" pattern as MockKYCProviderAdapter,
 * not a real sanctions-list match. Deterministic by fixture marker in
 * `name` (case-insensitive): containing `SANCTIONED` -> `HIT`, containing
 * `POTENTIAL` -> `POTENTIAL_MATCH`, anything else -> `CLEAR`. The default
 * (`SANCTIONS_PROVIDER` unset or `mock`) so local dev/e2e don't need the
 * real OFAC SDN list loaded. See `OfacSdnSanctionsAdapter` for the real,
 * list-matching alternative this same port also supports.
 */
@Injectable()
export class MockSanctionsScreeningAdapter extends SanctionsScreeningPort {
  private readonly logger = new Logger(MockSanctionsScreeningAdapter.name);
  private readonly baseUrl: string;

  constructor(private readonly configService: ConfigService) {
    super();
    this.baseUrl = configService.get<string>('SANCTIONS_PROVIDER_URL', 'http://localhost:4000/sanctions');
  }

  async screen(params: { name: string; taxId?: string; country?: string }): Promise<SanctionsScreeningResult> {
    const response = await fetch(`${this.baseUrl}/screen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Sanctions screening provider request failed (${response.status}): ${body}`);
    }

    const body = await response.json();
    this.logger.log(`Sanctions screening for "${params.name}": ${body.status}`);
    return { status: body.status, matchedListEntry: body.matchedListEntry, score: body.score };
  }
}
