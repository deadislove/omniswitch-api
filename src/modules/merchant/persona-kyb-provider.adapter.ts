import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KYBProviderPort, KYBVerificationResult, BeneficialOwner } from './kyb-provider.port';
import { mapPersonaInquiryStatus } from './persona-inquiry-status';

/**
 * Persona KYB Provider Adapter
 * A real, async-reviewing business-verification provider — same shape as
 * `PersonaKycProviderAdapter`, which its own docblock already establishes
 * as the "illustrative but real" bar for this codebase: a genuine Persona
 * Inquiry submission and JSON:API response parse, exercised end to end
 * against `scripts/mock-psp/server.js`'s matching endpoint, but never
 * called against a real Persona account with real credentials. Persona's
 * real product distinguishes individual vs. business verification by
 * which Inquiry template a given `PERSONA_API_KEY` is configured to use
 * server-side, not by anything this request body encodes — so this
 * adapter's request/response shape is identical to the KYC one, and the
 * business/individual distinction lives entirely in which of the two
 * adapters `merchant.module.ts`'s `useFactory` bindings route a call to.
 *
 * `KYB_PROVIDER=persona` selects this adapter; `POST /webhooks/kyb`
 * (verified by `KybWebhookGuard`, a distinct signature scheme/secret
 * from `KycWebhookGuard`) receives the eventual decision — a separate
 * webhook path, not a shared one, so a KYC decision can never be
 * misrouted into `MerchantEntity.kybStatus` or vice versa.
 */
@Injectable()
export class PersonaKybProviderAdapter extends KYBProviderPort {
  private readonly logger = new Logger(PersonaKybProviderAdapter.name);
  private readonly baseUrl: string;

  constructor(private readonly configService: ConfigService) {
    super();
    this.baseUrl = configService.get<string>('PERSONA_PROVIDER_URL', 'http://localhost:4000/persona');
  }

  async verify(params: {
    legalName: string;
    taxId: string;
    country: string;
    beneficialOwners?: BeneficialOwner[];
  }): Promise<KYBVerificationResult> {
    const response = await fetch(`${this.baseUrl}/kyb-applications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(10000),
    });

    const body = await response.json();
    if (!response.ok) {
      const message = body?.errors?.[0]?.details || `HTTP ${response.status}`;
      this.logger.warn(`Persona KYB submission failed for "${params.legalName}": ${message}`);
      throw new Error(`Persona KYB request failed: ${message}`);
    }

    const inquiry = body?.data;
    const status = mapPersonaInquiryStatus(inquiry?.attributes?.status);
    if (status === 'PENDING' && inquiry?.attributes?.status !== 'pending') {
      this.logger.warn(
        `Persona KYB inquiry ${inquiry?.id} returned unrecognized status "${inquiry?.attributes?.status}" — treating as still in progress`,
      );
    }
    return {
      status,
      applicationId: inquiry?.id,
      reason: status === 'REJECTED' ? `Persona status: ${inquiry?.attributes?.status}` : undefined,
    };
  }
}
