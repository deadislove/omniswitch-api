import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BankTransferPort, BankTransferRequest, BankTransferResponse } from '../../ports/outbound/bank-transfer.port';

/**
 * Mock Bank Transfer Adapter
 * Calls scripts/mock-psp/server.js's `/bank/transfers` endpoint — same
 * "point at a local mock in tests/dev" pattern as every other adapter in
 * this codebase, not a real bank/ACH/wire rail. Resolves synchronously
 * ("sent"); a real transfer settles over days and would need its own
 * webhook-driven confirmation the way dispute resolution/3DS do.
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
      return { success: false, rawResponse: body, errorMessage: body.error ?? 'Bank transfer request failed' };
    }

    this.logger.log(`Bank transfer for merchant ${request.merchantId}: ${body.status} (transferId=${body.id})`);
    return {
      success: body.status === 'sent',
      transferId: body.id,
      rawResponse: body,
      errorMessage: body.status !== 'sent' ? body.reason : undefined,
    };
  }
}
