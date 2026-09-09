import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BankTransferPort,
  BankTransferRequest,
  BankTransferResponse,
  BankTransferStatusResult,
} from '../../ports/outbound/bank-transfer.port';

/**
 * Mock Bank Transfer Adapter
 * Calls scripts/mock-psp/server.js's `/bank/transfers` endpoint — same
 * "point at a local mock in tests/dev" pattern as every other adapter in
 * this codebase, not a real bank/ACH/wire rail. Resolves synchronously
 * (`status: 'SENT'`) — the default (`BANK_TRANSFER_PROVIDER` unset or
 * `mock`) so local dev/e2e don't need a webhook round trip. See
 * `AchBankTransferAdapter`/`WireBankTransferAdapter` for the two real,
 * async-settling rails this same port also supports.
 */
@Injectable()
export class MockBankTransferAdapter extends BankTransferPort {
  private readonly logger = new Logger(MockBankTransferAdapter.name);
  private readonly baseUrl: string;

  constructor(private readonly configService: ConfigService) {
    super();
    this.baseUrl = configService.get<string>('BANK_TRANSFER_PROVIDER_URL', 'http://localhost:4000/bank');
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
    if (!response.ok) {
      return {
        success: false,
        status: 'FAILED',
        rawResponse: body,
        errorMessage: body.error ?? 'Bank transfer request failed',
      };
    }

    this.logger.log(`Bank transfer for merchant ${request.merchantId}: ${body.status} (transferId=${body.id})`);
    const sent = body.status === 'sent';
    return {
      success: sent,
      status: sent ? 'SENT' : 'FAILED',
      transferId: body.id,
      rawResponse: body,
      errorMessage: sent ? undefined : body.reason,
    };
  }

  /**
   * This rail resolves synchronously (see class docblock) — its webhook
   * (unused; `/bank/transfers` never calls it) would never need a
   * follow-up GET either, so this is never actually invoked against this
   * adapter in practice. Implemented anyway to satisfy the port honestly
   * rather than throwing.
   */
  async getTransferStatus(): Promise<BankTransferStatusResult | null> {
    return null;
  }
}
