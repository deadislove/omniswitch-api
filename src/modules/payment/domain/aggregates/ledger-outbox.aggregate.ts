import { Money } from '../value-objects/money.vo';

export type LedgerEntryType = 'DEBIT' | 'CREDIT';
export type OutboxStatus = 'PENDING' | 'PUBLISHED' | 'FAILED';

/**
 * Double-Entry Bookkeeping Ledger Entry
 * Every financial transaction must have balanced debit/credit entries.
 */
export interface LedgerEntry {
  accountId: string;
  accountType: 'MERCHANT' | 'PLATFORM' | 'PSP_SETTLEMENT' | 'FEE' | 'RESERVE' | 'FX_CLEARING';
  entryType: LedgerEntryType;
  amount: Money;
  description: string;
}

/**
 * Ledger Outbox Event
 * Implements the Transactional Outbox Pattern for reliable event publishing.
 * Written atomically with the Payment Intent in the same DB transaction.
 */
export class LedgerOutboxEvent {
  private constructor(
    public readonly id: string,
    public readonly paymentId: string,
    public readonly eventType: string,
    public readonly entries: LedgerEntry[],
    public readonly status: OutboxStatus,
    public readonly createdAt: Date,
    public readonly processedAt?: Date,
    public readonly retryCount: number = 0,
    public readonly lastError?: string,
  ) {
    this.validateDoubleEntry(entries);
  }

  static create(params: {
    id: string;
    paymentId: string;
    eventType: string;
    entries: LedgerEntry[];
  }): LedgerOutboxEvent {
    return new LedgerOutboxEvent(
      params.id,
      params.paymentId,
      params.eventType,
      params.entries,
      'PENDING',
      new Date(),
    );
  }

  static reconstitute(params: {
    id: string;
    paymentId: string;
    eventType: string;
    entries: LedgerEntry[];
    status: OutboxStatus;
    createdAt: Date;
    processedAt?: Date;
    retryCount?: number;
    lastError?: string;
  }): LedgerOutboxEvent {
    return new LedgerOutboxEvent(
      params.id,
      params.paymentId,
      params.eventType,
      params.entries,
      params.status,
      params.createdAt,
      params.processedAt,
      params.retryCount ?? 0,
      params.lastError,
    );
  }

  /**
   * Validates double-entry bookkeeping invariant:
   * Total debits must equal total credits for the same currency.
   */
  private validateDoubleEntry(entries: LedgerEntry[]): void {
    const byCurrency = new Map<string, { debits: bigint; credits: bigint }>();

    for (const entry of entries) {
      const code = entry.amount.currency.code;
      if (!byCurrency.has(code)) {
        byCurrency.set(code, { debits: 0n, credits: 0n });
      }
      const bal = byCurrency.get(code)!;
      if (entry.entryType === 'DEBIT') {
        bal.debits += entry.amount.amountMinorUnits;
      } else {
        bal.credits += entry.amount.amountMinorUnits;
      }
    }

    for (const [currency, { debits, credits }] of byCurrency) {
      if (debits !== credits) {
        throw new Error(
          `Double-entry imbalance for ${currency}: debits=${debits}, credits=${credits}`,
        );
      }
    }
  }

  /**
   * Factory: Create charge ledger entries for a payment
   * Merchant account is debited, platform receives credit (settlement)
   *
   * `settlementConversion` books the merchant's payout leg in a different
   * currency than the charge (see FXRateProviderPort) — e.g. a merchant
   * charged in USD but settled in EUR. This can't just be a third entry
   * in the charge-currency group above: validateDoubleEntry() balances
   * debits/credits *per currency*, and a payout leg in a different
   * currency than the charge would leave that group permanently
   * unbalanced. Instead it's two separately-balanced legs linked by an
   * FX_CLEARING account — standard double-entry treatment for a currency
   * conversion, not a special case bolted onto validateDoubleEntry() itself:
   *   - Charge-currency group: PSP_SETTLEMENT debit, FEE credit,
   *     FX_CLEARING credit (net amount) — still balances exactly as before.
   *   - Settlement-currency group: FX_CLEARING debit, MERCHANT credit
   *     (converted net amount) — balances on its own.
   *
   * `reserveHold` withholds a slice of the net amount into a per-merchant
   * RESERVE account instead of paying it out immediately (see
   * MerchantEntity.reserveBps/reserveHoldDays and the ReserveHold
   * aggregate that tracks when it becomes releasable). Always taken out of
   * the *charge*-currency net amount, before any settlement conversion —
   * a reserve is the platform temporarily not paying out funds it already
   * holds in the charge currency, not a separate currency-conversion
   * question. That composes cleanly with settlementConversion above: the
   * RESERVE credit is just a fourth entry in the charge-currency group
   * (which still balances, since it's carved out of the same net amount
   * that would otherwise have gone entirely to MERCHANT or FX_CLEARING),
   * and everything downstream of "net amount" — the FX_CLEARING/MERCHANT
   * legs — uses net-of-reserve instead of the full net amount.
   *
   * `splits` divides the (net-of-fee, net-of-reserve) payout amount across
   * one or more CONNECTED merchants instead of crediting all of it to
   * `params.merchantId` — a marketplace charge routing part of its
   * proceeds directly to the sellers who actually fulfilled it. Each split
   * is its own MERCHANT credit, keyed by the recipient's own merchantId;
   * whatever's left after all splits still goes to `params.merchantId` (a
   * split doesn't have to add up to the full payout — see
   * ChargeLedgerParamsResolverService.resolve()'s SPLIT_EXCEEDS_NET_AMOUNT
   * check for why it never exceeds it). Mutually exclusive with
   * `settlementConversion` by construction (the resolver rejects a split
   * request for a merchant with an active settlement-currency conversion,
   * since deciding which FX rate applies to a charge that's partly
   * "platform pricing" and partly "connected-account pricing" is a real
   * design question this system doesn't attempt) — this method doesn't
   * re-check that, it trusts the resolver already did.
   */
  static createChargeEntries(params: {
    id: string;
    paymentId: string;
    merchantId: string;
    amount: Money;
    platformFee: Money;
    settlementConversion?: {
      convertedNetAmount: Money;
      rate: number;
      provider: string;
    };
    reserveHold?: {
      amount: Money;
    };
    splits?: {
      merchantId: string;
      amount: Money;
    }[];
  }): LedgerOutboxEvent {
    const netAmount = params.amount.subtract(params.platformFee);
    const payoutAmount = params.reserveHold ? netAmount.subtract(params.reserveHold.amount) : netAmount;

    const entries: LedgerEntry[] = [
      {
        accountId: 'PSP_SETTLEMENT_ACCOUNT',
        accountType: 'PSP_SETTLEMENT',
        entryType: 'DEBIT',
        amount: params.amount,
        description: `PSP settlement debit for payment ${params.paymentId}`,
      },
      {
        accountId: 'PLATFORM_FEE_ACCOUNT',
        accountType: 'FEE',
        entryType: 'CREDIT',
        amount: params.platformFee,
        description: `Platform fee for payment ${params.paymentId}`,
      },
    ];

    if (params.reserveHold) {
      entries.push({
        accountId: `${params.merchantId}_RESERVE`,
        accountType: 'RESERVE',
        entryType: 'CREDIT',
        amount: params.reserveHold.amount,
        description: `Reserve withheld from payment ${params.paymentId}`,
      });
    }

    if (params.splits && params.splits.length > 0) {
      let remaining = payoutAmount;
      for (const split of params.splits) {
        remaining = remaining.subtract(split.amount);
        entries.push({
          accountId: split.merchantId,
          accountType: 'MERCHANT',
          entryType: 'CREDIT',
          amount: split.amount,
          description: `Marketplace split payout for payment ${params.paymentId}`,
        });
      }
      if (!remaining.isZero()) {
        entries.push({
          accountId: params.merchantId,
          accountType: 'MERCHANT',
          entryType: 'CREDIT',
          amount: remaining,
          description: `Payment received (after marketplace split) for payment ${params.paymentId}`,
        });
      }
    } else if (params.settlementConversion) {
      const { convertedNetAmount, rate, provider } = params.settlementConversion;
      const fxDescription =
        `FX conversion ${payoutAmount.currency.code}->${convertedNetAmount.currency.code} ` +
        `@ ${rate} (${provider}) for payment ${params.paymentId}`;
      entries.push(
        {
          accountId: 'FX_CLEARING_ACCOUNT',
          accountType: 'FX_CLEARING',
          entryType: 'CREDIT',
          amount: payoutAmount,
          description: fxDescription,
        },
        {
          accountId: 'FX_CLEARING_ACCOUNT',
          accountType: 'FX_CLEARING',
          entryType: 'DEBIT',
          amount: convertedNetAmount,
          description: fxDescription,
        },
        {
          accountId: params.merchantId,
          accountType: 'MERCHANT',
          entryType: 'CREDIT',
          amount: convertedNetAmount,
          description: `Payment received (settled in ${convertedNetAmount.currency.code}) for payment ${params.paymentId}`,
        },
      );
    } else {
      entries.push({
        accountId: params.merchantId,
        accountType: 'MERCHANT',
        entryType: 'CREDIT',
        amount: payoutAmount,
        description: `Payment received for payment ${params.paymentId}`,
      });
    }

    return LedgerOutboxEvent.create({
      id: params.id,
      paymentId: params.paymentId,
      eventType: 'PAYMENT_CHARGED',
      entries,
    });
  }

  /**
   * Factory: Release a previously-withheld reserve amount back to the
   * merchant — the offsetting entry to the RESERVE credit
   * createChargeEntries() books above. Always a same-currency, two-entry
   * balance (no FX_CLEARING involved): a reserve is released in whatever
   * currency it was withheld in, regardless of whether the merchant now
   * has a settlement currency configured — see ReserveService's docblock
   * for why re-converting at release time is out of scope here.
   */
  static createReserveReleaseEntries(params: {
    id: string;
    paymentId: string;
    merchantId: string;
    amount: Money;
  }): LedgerOutboxEvent {
    const entries: LedgerEntry[] = [
      {
        accountId: `${params.merchantId}_RESERVE`,
        accountType: 'RESERVE',
        entryType: 'DEBIT',
        amount: params.amount,
        description: `Reserve released for payment ${params.paymentId}`,
      },
      {
        accountId: params.merchantId,
        accountType: 'MERCHANT',
        entryType: 'CREDIT',
        amount: params.amount,
        description: `Reserve released for payment ${params.paymentId}`,
      },
    ];

    return LedgerOutboxEvent.create({
      id: params.id,
      paymentId: params.paymentId,
      eventType: 'RESERVE_RELEASED',
      entries,
    });
  }

  /**
   * Factory: Create refund ledger entries.
   *
   * `settlementConversion` — present when the *original charge* this
   * refund belongs to was settlement-converted (see
   * PaymentAggregate.recordSettlementConversion()). Without it, a refund
   * against a merchant who was actually paid out in a different currency
   * would debit their MERCHANT account in the *charge* currency while
   * their real balance sits in the *settlement* currency — two ledger
   * lines that never net against each other, silently leaving the
   * merchant either short-refunded or over-refunded depending on which
   * way the rate moved since the charge. Uses the *original* charge-time
   * rate, not a fresh one — refunding at a different rate than the money
   * was paid out at would just create a new mismatch instead of fixing
   * the old one. Same two-leg-via-FX_CLEARING shape as
   * createChargeEntries()'s settlementConversion, just with every entry
   * type flipped (this reverses a payout, not creates one):
   *   - Charge-currency group: PSP_SETTLEMENT credit, FX_CLEARING debit
   *     (refund amount) — balances on its own.
   *   - Settlement-currency group: FX_CLEARING credit, MERCHANT debit
   *     (converted refund amount) — balances on its own.
   *
   * `splits`/`originalChargeAmount` — present when the *original charge*
   * routed part of its proceeds to CONNECTED merchants (see
   * PaymentAggregate.recordSplits()). Without these, a refund of a split
   * payment would debit only the charging (platform) merchant for the
   * full amount, even though part of that money was never credited to the
   * platform in the first place — see this method's `splits` param
   * docblock below for the proportional-reversal math. Mutually exclusive
   * with `settlementConversion` by construction (a merchant with an
   * active settlement conversion can't create a split charge — see
   * ChargeLedgerParamsResolverService.resolve()'s
   * SPLIT_WITH_SETTLEMENT_CONVERSION_UNSUPPORTED check) — this method
   * doesn't re-check that, it trusts the caller already did.
   */
  static createRefundEntries(params: {
    id: string;
    paymentId: string;
    merchantId: string;
    refundAmount: Money;
    settlementConversion?: {
      convertedRefundAmount: Money;
      rate: number;
      provider: string;
    };
    /**
     * The *original* charge-time splits and the full original charge
     * amount they were carved out of — needed together, since a partial
     * refund reverses each recipient's share in the same proportion the
     * charge itself split (refundAmount / originalChargeAmount), not a
     * fixed amount. Computed in integer minor units (floor division per
     * split, remainder absorbed by the platform's own debit) rather than
     * floating-point fractions, so a full refund (refundAmount ==
     * originalChargeAmount) reproduces each split's exact original amount
     * with no rounding drift, and a partial refund can never claw back
     * more than `refundAmount` in total regardless of how many splits
     * there are.
     */
    splits?: {
      merchantId: string;
      amount: Money;
    }[];
    originalChargeAmount?: Money;
  }): LedgerOutboxEvent {
    const entries: LedgerEntry[] = [
      {
        accountId: 'PSP_SETTLEMENT_ACCOUNT',
        accountType: 'PSP_SETTLEMENT',
        entryType: 'CREDIT',
        amount: params.refundAmount,
        description: `PSP refund credit for payment ${params.paymentId}`,
      },
    ];

    if (params.splits && params.splits.length > 0 && params.originalChargeAmount) {
      const refundMinorUnits = params.refundAmount.amountMinorUnits;
      const chargeMinorUnits = params.originalChargeAmount.amountMinorUnits;
      let connectedTotal = 0n;
      for (const split of params.splits) {
        const debitMinorUnits = (split.amount.amountMinorUnits * refundMinorUnits) / chargeMinorUnits;
        connectedTotal += debitMinorUnits;
        if (debitMinorUnits > 0n) {
          entries.push({
            accountId: split.merchantId,
            accountType: 'MERCHANT',
            entryType: 'DEBIT',
            amount: Money.fromMinorUnits(debitMinorUnits, params.refundAmount.currency.code),
            description: `Marketplace split refund debit for payment ${params.paymentId}`,
          });
        }
      }
      const platformDebitMinorUnits = refundMinorUnits - connectedTotal;
      if (platformDebitMinorUnits > 0n) {
        entries.push({
          accountId: params.merchantId,
          accountType: 'MERCHANT',
          entryType: 'DEBIT',
          amount: Money.fromMinorUnits(platformDebitMinorUnits, params.refundAmount.currency.code),
          description: `Refund debit (after marketplace split reversal) for payment ${params.paymentId}`,
        });
      }
    } else if (params.settlementConversion) {
      const { convertedRefundAmount, rate, provider } = params.settlementConversion;
      const fxDescription =
        `FX conversion (refund) ${params.refundAmount.currency.code}->${convertedRefundAmount.currency.code} ` +
        `@ ${rate} (${provider}) for payment ${params.paymentId}`;
      entries.push(
        {
          accountId: 'FX_CLEARING_ACCOUNT',
          accountType: 'FX_CLEARING',
          entryType: 'DEBIT',
          amount: params.refundAmount,
          description: fxDescription,
        },
        {
          accountId: 'FX_CLEARING_ACCOUNT',
          accountType: 'FX_CLEARING',
          entryType: 'CREDIT',
          amount: convertedRefundAmount,
          description: fxDescription,
        },
        {
          accountId: params.merchantId,
          accountType: 'MERCHANT',
          entryType: 'DEBIT',
          amount: convertedRefundAmount,
          description: `Refund debit (settled in ${convertedRefundAmount.currency.code}) for payment ${params.paymentId}`,
        },
      );
    } else {
      entries.push({
        accountId: params.merchantId,
        accountType: 'MERCHANT',
        entryType: 'DEBIT',
        amount: params.refundAmount,
        description: `Refund debit for payment ${params.paymentId}`,
      });
    }

    return LedgerOutboxEvent.create({
      id: params.id,
      paymentId: params.paymentId,
      eventType: 'PAYMENT_REFUNDED',
      entries,
    });
  }
}
