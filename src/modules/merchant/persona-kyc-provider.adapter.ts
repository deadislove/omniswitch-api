import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KYCProviderPort, KYCVerificationResult } from './kyc-provider.port';
import { mapPersonaInquiryStatus } from './persona-inquiry-status';

/**
 * Persona KYC Provider Adapter
 * A real, async-reviewing identity/business-verification provider — an
 * Inquiry is `POST`ed, the provider's own review (sometimes a human)
 * decides `approved`/`declined` later, reported via `POST /webhooks/kyc`
 * (verified by `KycWebhookGuard`). Selected via `KYC_PROVIDER=persona`
 * (see `merchant.module.ts`'s `useFactory` binding for `KYCProviderPort`).
 *
 * Response shape confirmed against Persona's own published API docs
 * (docs.withpersona.com/integration-guide-understanding-a-persona-api-payload,
 * docs.withpersona.com/errors), not guessed — earlier revisions of this
 * adapter assumed a flat `{id, status}` body, which is **not** what
 * Persona's real API actually returns. A real Inquiry response is
 * JSON:API-shaped: `{data: {type: 'inquiry', id, attributes: {status}}}`;
 * a real error response is `{errors: [{title, details}]}`. Persona's own
 * real status vocabulary is also richer than a binary
 * pending/approved/declined — see `mapPersonaInquiryStatus()`'s docblock
 * for the full list and why `completed` specifically is *not* a decision.
 * `scripts/mock-psp/server.js`'s `/persona/kyc-applications` endpoint now
 * speaks this same real shape, so this adapter exercises its actual
 * parsing logic end to end, not a shape that happens to be convenient —
 * but nothing in this repo has ever called a real Persona account with
 * real credentials, so field names beyond what's cited above (e.g. the
 * exact attribute a real decline reason lives under) are not verified.
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
    if (!response.ok) {
      const detail = body.errors?.[0]?.details ?? body.errors?.[0]?.title ?? 'Application submission rejected';
      return { status: 'REJECTED', applicationId: 'unknown', reason: detail };
    }

    const applicationId: string = body.data?.id ?? 'unknown';
    const status = mapPersonaInquiryStatus(body.data?.attributes?.status);
    if (status !== 'PENDING') {
      // A real Inquiry-creation response is never anything but a fresh,
      // undecided status — this branch only exists because the mock's
      // synchronous-rejection marker (a malformed submission a real
      // provider could reject immediately, before any review starts)
      // needs somewhere to surface as a decision without waiting for the
      // async webhook path below.
      return { status, applicationId, reason: status === 'REJECTED' ? 'Application rejected' : undefined };
    }

    this.logger.log(`KYC application submitted for "${params.legalName}": applicationId=${applicationId} (pending review)`);
    return { status: 'PENDING', applicationId };
  }
}
