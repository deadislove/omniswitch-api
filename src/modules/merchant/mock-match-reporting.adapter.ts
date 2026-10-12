import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MatchReportingPort, MatchReportResult } from './match-reporting.port';
import { MatchReasonCode } from './match-reason-code';

/**
 * Mock MATCH Reporting Adapter
 * Calls scripts/mock-psp/server.js's `/match/report` endpoint — same
 * "point at a local mock in tests/dev" pattern as MockKYCProviderAdapter/
 * MockSanctionsScreeningAdapter, standing in for a real Mastercard MATCH
 * filing. The only adapter this port has — see MatchReportingPort's own
 * docblock for why there's no real counterpart to switch to.
 */
@Injectable()
export class MockMatchReportingAdapter extends MatchReportingPort {
  private readonly logger = new Logger(MockMatchReportingAdapter.name);
  private readonly baseUrl: string;

  constructor(configService: ConfigService) {
    super();
    this.baseUrl = configService.get<string>('MATCH_REPORTING_URL', 'http://localhost:4000/match');
  }

  async report(params: {
    merchantId: string;
    legalName: string;
    reasonCode: MatchReasonCode;
    reason: string;
  }): Promise<MatchReportResult> {
    const response = await fetch(`${this.baseUrl}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`MATCH reporting request failed (${response.status}): ${body}`);
    }

    const body = await response.json();
    this.logger.warn(
      `Merchant ${params.merchantId} reported to MATCH (code ${params.reasonCode}): reportId=${body.reportId}`,
    );
    return { reportId: body.reportId, reportedAt: new Date(body.reportedAt) };
  }
}
