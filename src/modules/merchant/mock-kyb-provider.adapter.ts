import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KYBProviderPort, KYBVerificationResult, BeneficialOwner } from './kyb-provider.port';

/**
 * Mock KYB Provider Adapter
 * Calls scripts/mock-psp/server.js's `/kyb/verify` endpoint — same
 * "point at a local mock in tests/dev" pattern as `MockKYCProviderAdapter`.
 * Resolves synchronously (`APPROVED`/`REJECTED`, never `PENDING`) — the
 * default (`KYB_PROVIDER` unset or `mock`). See `PersonaKybProviderAdapter`
 * for the real, async-reviewing alternative this same port also supports.
 */
@Injectable()
export class MockKYBProviderAdapter extends KYBProviderPort {
  private readonly logger = new Logger(MockKYBProviderAdapter.name);
  private readonly baseUrl: string;

  constructor(private readonly configService: ConfigService) {
    super();
    this.baseUrl = configService.get<string>('KYB_PROVIDER_URL', 'http://localhost:4000/kyb');
  }

  async verify(params: {
    legalName: string;
    taxId: string;
    country: string;
    beneficialOwners?: BeneficialOwner[];
  }): Promise<KYBVerificationResult> {
    const response = await fetch(`${this.baseUrl}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`KYB provider request failed (${response.status}): ${body}`);
    }

    const body = await response.json();
    const status = body.approved === true ? 'APPROVED' : 'REJECTED';
    this.logger.log(`KYB verification for "${params.legalName}": ${status} (applicationId=${body.applicationId})`);
    return { status, applicationId: body.applicationId, reason: body.reason };
  }
}
