import { Money } from '../../domain/value-objects/money.vo';

export interface BankTransferRequest {
  merchantId: string;
  amount: Money;
  idempotencyKey: string;
}

/**
 * `SENT` — the rail confirmed final settlement synchronously, in the same
 * call (only `MockBankTransferAdapter` does this; it's how a same-process
 * mock stands in for a rail that in reality never settles this fast).
 * `PENDING` — the rail accepted the transfer for processing but hasn't
 * settled it yet; final outcome arrives later via
 * `POST /webhooks/bank-transfer` (`AchBankTransferAdapter`/
 * `WireBankTransferAdapter` both work this way — a real ACH/wire transfer
 * takes hours to days, never seconds).
 * `FAILED` — rejected outright, synchronously (bad account details, etc.).
 */
export type BankTransferStatus = 'SENT' | 'PENDING' | 'FAILED';

export interface BankTransferResponse {
  /** True for SENT or PENDING (accepted for processing); false for FAILED. */
  success: boolean;
  status: BankTransferStatus;
  transferId?: string;
  rawResponse: Record<string, unknown>;
  errorMessage?: string;
}

/**
 * Bank Transfer Port (Outbound)
 * The real payout/bank-transfer initiation `Payout.netAmount` never had —
 * see docs/business-domain/marketplace-and-payouts.md#payout-kyc-gating-and-real-transfer-initiation
 * for why, before this, a `Payout` was purely a scheduling/accounting
 * record with no rail to actually move money. Same "single external HTTP
 * call" shape as FXRateProviderPort/KYCProviderPort, not a whole
 * PSP-style multi-method interface.
 *
 * Three concrete adapters implement this — `MockBankTransferAdapter`
 * (synchronous, local dev/test default), `AchBankTransferAdapter`, and
 * `WireBankTransferAdapter` (both real, async-settling rails) — selected
 * at DI-container build time via `BANK_TRANSFER_PROVIDER`
 * (`mock`/`ach`/`wire`) in `payment.module.ts`'s `useFactory` binding for
 * this port, the same "one env var picks which concrete adapter answers
 * this interface" idiom `scripts/jobs/backup-storage/get-backup-storage.ts`
 * uses for `DELETION_BACKUP_STORAGE` — the difference is that binding
 * happens inside Nest DI here (these adapters have their own injected
 * dependencies) rather than in a standalone script.
 */
export abstract class BankTransferPort {
  abstract initiateTransfer(request: BankTransferRequest): Promise<BankTransferResponse>;
}
