import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BankTransferPort, BankTransferRequest, BankTransferResponse } from '../../ports/outbound/bank-transfer.port';

/**
 * ACH Bank Transfer Adapter
 * A real ACH rail (modeled on the shape a provider like Dwolla/Modern
 * Treasury exposes: `POST /transfers` returns `202 { id, status: 'pending' }`
 * immediately, then the rail's own clearing cycle — hours, sometimes a
 * full banking day — decides `settled`/`failed` and reports it back via
 * `POST /webhooks/bank-transfer`, verified by `BankTransferWebhookGuard`).
 * Selected via `BANK_TRANSFER_PROVIDER=ach` (see `payment.module.ts`'s
 * `useFactory` binding for `BankTransferPort`).
 *
 * Same honest posture as `test/contract/stripe.contract-spec.ts` for the
 * PSP adapters: this is a real, runnable adapter — `scripts/mock-psp/server.js`'s
 * `/ach/transfers` endpoint exercises it end to end, including the async
 * webhook callback — but nothing in this repo has ever called a real ACH
 * provider with real credentials. `ACH_PROVIDER_URL` would point at that
 * real provider's API in a real deployment; nothing else about this class
 * would need to change, since the mock speaks the same `{id, status}` shape.
 */
@Injectable()
export class AchBankTransferAdapter extends BankTransferPort {
  private readonly logger = new Logger(AchBankTransferAdapter.name);
  private readonly baseUrl: string;

  constructor(private readonly configService: ConfigService) {
    super();
    this.baseUrl = configService.get<string>('ACH_PROVIDER_URL', 'http://localhost:4000/ach');
  }

  async initiateTransfer(request: BankTransferRequest): Promise<BankTransferResponse> {
    const response = await fetch(`${this.baseUrl}/transfers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': request.idempotencyKey },
      body: JSON.stringify({
        merchantId: request.merchantId,
        amountMinorUnits: request.amount.amountMinorUnits.toString(),
        currency: request.amount.currency.code,
      }),
      signal: AbortSignal.timeout(15000),
    });

    const body = await response.json();
    if (!response.ok || body.status === 'rejected') {
      return {
        success: false,
        status: 'FAILED',
        rawResponse: body,
        errorMessage: body.error ?? body.reason ?? 'ACH transfer request rejected',
      };
    }

    this.logger.log(
      `ACH transfer submitted for merchant ${request.merchantId}: transferId=${body.id} (pending clearing)`,
    );
    return { success: true, status: 'PENDING', transferId: body.id, rawResponse: body };
  }
}
