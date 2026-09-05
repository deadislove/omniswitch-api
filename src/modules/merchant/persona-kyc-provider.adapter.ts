import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KYCProviderPort, KYCVerificationResult } from './kyc-provider.port';

/**
 * Persona KYC Provider Adapter
 * A real, async-reviewing identity/business-verification provider
 * (modeled on the shape Persona/Onfido actually expose: `POST` an
 * application, get `202 { id, status: 'pending' }` back immediately,
 * then the provider's own review — sometimes involving a human — decides
 * `approved`/`declined` and reports it later via `POST /webhooks/kyc`,
 * verified by `KycWebhookGuard`). Selected via `KYC_PROVIDER=persona`
 * (see `merchant.module.ts`'s `useFactory` binding for `KYCProviderPort`).
 *
 * Same honest posture as the ACH/wire bank-transfer rails and
 * `test/contract/stripe.contract-spec.ts`: this is a real, runnable
 * adapter — `scripts/mock-psp/server.js`'s `/persona/kyc-applications`
 * endpoint exercises it end to end, including the async signed webhook
 * callback — but nothing in this repo has ever called a real Persona/
 * Onfido account with real credentials. `PERSONA_PROVIDER_URL` would
 * point at that real provider's API in a real deployment; nothing else
 * about this class would need to change, since the mock speaks the same
 * `{id, status}` shape.
 */
@Injectable()
export class PersonaKycProviderAdapter extends KYCProviderPort {
  private readonly logger = new Logger(PersonaKycProviderAdapter.name);
  private readonly baseUrl: string;

  constructor(private readonly configService: ConfigService) {
    super();
    this.baseUrl = configService.get<string>('PERSONA_PROVIDER_URL', 'http://localhost:4000/persona');
  }

  async verify(params: { legalName: string; taxId: string }): Promise<KYCVerificationResult> {
    const response = await fetch(`${this.baseUrl}/kyc-applications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ legalName: params.legalName, taxId: params.taxId }),
      signal: AbortSignal.timeout(10000),
    });

    const body = await response.json();
    if (!response.ok || body.status === 'declined') {
      return {
        status: 'REJECTED',
        applicationId: body.id ?? 'unknown',
        reason: body.error ?? body.reason ?? 'Application rejected',
      };
    }

    this.logger.log(`KYC application submitted for "${params.legalName}": applicationId=${body.id} (pending review)`);
    return { status: 'PENDING', applicationId: body.id };
  }
}
