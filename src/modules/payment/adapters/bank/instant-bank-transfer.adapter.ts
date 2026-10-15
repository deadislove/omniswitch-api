import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BankTransferPort,
  BankTransferRequest,
  BankTransferResponse,
  BankTransferStatusResult,
} from '../../ports/outbound/bank-transfer.port';

/**
 * Instant Bank Transfer Adapter
 * Same `POST /transfers` -> `pending` -> webhook-confirmed shape as
 * `AchBankTransferAdapter`/`WireBankTransferAdapter` — real Stripe
 * Instant Payouts and Visa Direct push-to-card are genuinely still
 * async (`POST /v1/payouts {method: 'instant'}` returns `pending`
 * immediately; a `payout.paid`/`payout.failed` webhook resolves it
 * later), just typically settling within minutes rather than the
 * standard rail's 1-2 business days. This mock can't simulate that
 * wall-clock difference any more than it can for Ach/Wire's own
 * multi-day cycle (every rail here resolves whenever a test fires its
 * webhook, not after real elapsed time) — the two things that actually
 * distinguish this rail in this codebase are being a separately
 * selectable choice (`Payout.transferRail`) and carrying a real premium
 * fee (`calculateInstantPayoutFee()`), not a faster wall clock. Selected
 * directly by `PayoutService.initiateTransfer()`'s rail resolution —
 * unlike Ach/Wire, never via the global `BANK_TRANSFER_PROVIDER` pick,
 * since choosing instant is a per-payout/per-merchant decision rather
 * than a whole-deployment default (see `PayoutRail`'s own docblock).
 */
@Injectable()
export class InstantBankTransferAdapter extends BankTransferPort {
  private readonly logger = new Logger(InstantBankTransferAdapter.name);
  private readonly baseUrl: string;

  constructor(private readonly configService: ConfigService) {
    super();
    this.baseUrl = configService.get<string>('INSTANT_PROVIDER_URL', 'http://localhost:4000/instant');
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
        errorMessage: body.error ?? body.reason ?? 'Instant transfer request rejected',
      };
    }

    this.logger.log(
      `Instant transfer submitted for merchant ${request.merchantId}: transferId=${body.id} (pending settlement)`,
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
