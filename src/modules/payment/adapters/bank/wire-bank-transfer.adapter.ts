import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BankTransferPort,
  BankTransferRequest,
  BankTransferResponse,
  BankTransferStatusResult,
} from '../../ports/outbound/bank-transfer.port';

/**
 * Wire Bank Transfer Adapter
 * Same shape as `AchBankTransferAdapter` — `POST /transfers` accepted
 * synchronously (`pending`), final `settled`/`failed` learned later via
 * a lightweight webhook notification plus a follow-up `GET` — but a
 * distinct rail (wire transfers clear same-day, not over ACH's multi-day
 * cycle, and use a different provider API in reality). Kept as its own
 * adapter rather than a `railType` flag on `AchBankTransferAdapter`
 * because a real wire integration (Fedwire/SWIFT-shaped) and a real ACH
 * integration (NACHA-shaped) are genuinely different provider APIs with
 * different required fields, not the same request shape wearing a
 * different label. Selected via `BANK_TRANSFER_PROVIDER=wire`.
 *
 * Same real-shape fix as `AchBankTransferAdapter`'s own docblock
 * describes for Dwolla's lightweight-notification-plus-follow-up-GET
 * pattern — see that class for the citation. Wire transfers have no
 * single dominant real API the way Dwolla is a concrete, named example
 * for ACH, so this adapter's async *shape* now matches the same real
 * pattern without being committed to any one named wire provider's exact
 * field set.
 */
@Injectable()
export class WireBankTransferAdapter extends BankTransferPort {
  private readonly logger = new Logger(WireBankTransferAdapter.name);
  private readonly baseUrl: string;

  constructor(private readonly configService: ConfigService) {
    super();
    this.baseUrl = configService.get<string>('WIRE_PROVIDER_URL', 'http://localhost:4000/wire');
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
        errorMessage: body.error ?? body.reason ?? 'Wire transfer request rejected',
      };
    }

    this.logger.log(
      `Wire transfer submitted for merchant ${request.merchantId}: transferId=${body.id} (pending settlement)`,
    );
    return { success: true, status: 'PENDING', transferId: body.id, rawResponse: body };
  }

  async getTransferStatus(transferId: string): Promise<BankTransferStatusResult | null> {
    const response = await fetch(`${this.baseUrl}/transfers/${encodeURIComponent(transferId)}`, {
      method: 'GET',
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 404) {
      return null;
    }
    const body = await response.json();
    if (!response.ok || (body.status !== 'settled' && body.status !== 'failed')) {
      return null;
    }
    return { status: body.status === 'settled' ? 'SETTLED' : 'FAILED', reason: body.reason };
  }
}
