import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KYCProviderPort, KYCVerificationResult } from './kyc-provider.port';

/**
 * Mock KYC Provider Adapter
 * Calls scripts/mock-psp/server.js's `/kyc/verify` endpoint — same
 * "point at a local mock in tests/dev" pattern as FXRateProviderAdapter/
 * the PSP adapters' configurable base URLs, not a real identity-verification
 * provider (Persona, Onfido, Stripe Identity, ...).
 */
@Injectable()
export class MockKYCProviderAdapter extends KYCProviderPort {
  private readonly logger = new Logger(MockKYCProviderAdapter.name);
  private readonly baseUrl: string;

  constructor(private readonly configService: ConfigService) {
    super();
    this.baseUrl = configService.get<string>('KYC_PROVIDER_URL', 'http://localhost:4000/kyc');
  }

  async verify(params: { legalName: string; taxId: string }): Promise<KYCVerificationResult> {
    const response = await fetch(`${this.baseUrl}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ legalName: params.legalName, taxId: params.taxId }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`KYC provider request failed (${response.status}): ${body}`);
    }

    const body = await response.json();
    this.logger.log(`KYC verification for "${params.legalName}": ${body.approved ? 'approved' : 'declined'} (applicationId=${body.applicationId})`);
    return { approved: body.approved === true, applicationId: body.applicationId, reason: body.reason };
  }
}
