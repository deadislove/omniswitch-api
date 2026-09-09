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
/** The two terminal outcomes a `PENDING` transfer can resolve to — never `PENDING` itself; a still-pending transfer has nothing to report yet, so `getTransferStatus()` returns `null` for it (see below). */
export type BankTransferOutcome = 'SETTLED' | 'FAILED';

export interface BankTransferStatusResult {
  status: BankTransferOutcome;
  reason?: string;
}

export abstract class BankTransferPort {
  abstract initiateTransfer(request: BankTransferRequest): Promise<BankTransferResponse>;

  /**
   * Follow-up lookup for a `PENDING` transfer's real outcome. Exists
   * because a real async rail's webhook — Dwolla's included
   * (developers.dwolla.com/docs/webhook-events) — is a lightweight
   * `{id, topic, resourceId}` *notification*, not an outcome payload: the
   * receiver has to fetch the resource itself to learn anything beyond
   * "something happened," including a failure reason.
   * `WebhookController.bankTransferWebhook()` calls this after a failure
   * notification to get `reason` for `PayoutService.confirmTransfer()`.
   * Returns `null` if the rail doesn't know this transfer id, or if this
   * adapter's rail never has an async follow-up call at all
   * (`MockBankTransferAdapter` — its webhook payload already carries the
   * outcome inline, so this is never invoked against it in practice).
   */
  abstract getTransferStatus(transferId: string): Promise<BankTransferStatusResult | null>;
}
