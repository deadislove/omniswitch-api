import { Money } from '../../domain/value-objects/money.vo';

export interface BankTransferRequest {
  merchantId: string;
  amount: Money;
  idempotencyKey: string;
}

export interface BankTransferResponse {
  success: boolean;
  transferId?: string;
  rawResponse: Record<string, unknown>;
  errorMessage?: string;
}

/**
 * Bank Transfer Port (Outbound)
 * The real payout/bank-transfer initiation `Payout.netAmount` never had —
 * see docs/business-domain/ledger-and-settlement.md#payout-scheduling-for-connected-accounts
 * for why, before this, a `Payout` was purely a scheduling/accounting
 * record with no rail to actually move money. Same "single external HTTP
 * call" shape as FXRateProviderPort/KYCProviderPort, not a whole
 * PSP-style multi-method interface.
 */
export abstract class BankTransferPort {
  abstract initiateTransfer(request: BankTransferRequest): Promise<BankTransferResponse>;
}
