import { Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { Money } from '../../domain/value-objects/money.vo';
import { MerchantEntity } from '../../../merchant/merchant.entity';
import { MerchantService } from '../../../merchant/merchant.service';
import { FXRateProviderPort } from '../../ports/outbound/fx-rate-provider.port';
import { PaymentRepositoryPort } from '../../ports/outbound/payment-repository.port';
import { PSPProvider, PaymentSplit } from '../../domain/aggregates/payment.aggregate';

// Fallback only for the (shouldn't-happen) case of no merchant record —
// every caller of this service already only runs for an authenticated,
// JWT-bearing merchant or a payment created by one, so this is defensive,
// not a real code path. Matches the default MerchantEntity.platformFeeBps
// carries for every merchant created without an explicit rate.
const DEFAULT_PLATFORM_FEE_BPS = 150;

export interface ChargeLedgerParams {
  platformFee: Money;
  // When `splits` is present, this converts the *remainder* left to the
  // charging merchant after all splits are carved out — not the full
  // payout amount. Each split can independently carry its own conversion
  // (see `splits` below); this field and each split's own conversion are
  // no longer mutually exclusive, and may use different rates/currencies.
  settlementConversion?: { convertedNetAmount: Money; rate: number; provider: string };
  // netAmount alongside amount (the reserve slice itself) — ReserveHold
  // stores both, since a later reserveBps escalation needs the *original*
  // net amount this hold was carved from to recompute what the hold
  // should be at the new rate; the reserve slice alone doesn't carry
  // enough information to derive it back (recovering it would mean
  // assuming a bps that may not even be the one in effect when this hold
  // was created). See ReserveService.topUpHeldReservesForMerchant().
  reserveHold?: { amount: Money; holdDays: number; netAmount: Money };
  splits?: {
    merchantId: string;
    amount: Money;
    // Present when this recipient has their own settlementCurrency,
    // independent of the charging merchant's own conversion above.
    settlementConversion?: { convertedAmount: Money; rate: number; provider: string };
  }[];
  /**
   * The merchant's MerchantEntity.enabledPspProviders, cast to PSPProvider[]
   * — piggybacking on the merchant lookup this method already does rather
   * than making PaymentCheckoutSaga/AcquirerRoutingService do a second one.
   * Only unset in the shouldn't-happen "no merchant record" case (same
   * fallback posture as resolvePlatformFeeBps's DEFAULT_PLATFORM_FEE_BPS
   * above) — SmartRoutingStrategy treats undefined as "no restriction," not
   * "entitled to nothing," so this fallback is deliberately permissive.
   */
  enabledPspProviders?: PSPProvider[];
}

/**
 * Charge Ledger Params Resolver
 * One merchant lookup, feeding everything LedgerOutboxEvent.createChargeEntries()
 * needs beyond the raw charge amount: the platform fee rate, an optional FX
 * settlement conversion, and an optional reserve hold. Extracted out of
 * PaymentCheckoutSaga/PaymentLifecycleService/WebhookProcessingService,
 * which each carried an identical private copy of this — justified while it
 * was "just" the fee rate for two callers, explicitly flagged as a
 * three-caller judgment call once FX conversion was added, and finally
 * extracted here now that reserve holds make it a third concern layered on
 * the same lookup. All three call sites still separately create the
 * ReserveHold record itself (via ReserveService.recordHold(), in the same
 * DB transaction as their own ledger outbox write) — this service only
 * computes the numbers, it doesn't have opinions about each caller's
 * transaction boundary.
 */
@Injectable()
export class ChargeLedgerParamsResolverService {
  private readonly logger = new Logger(ChargeLedgerParamsResolverService.name);

  constructor(
    private readonly merchantService: MerchantService,
    private readonly fxRateProvider: FXRateProviderPort,
    private readonly paymentRepository: PaymentRepositoryPort,
  ) {}

  /**
   * platformFeeBps, unless `merchant.feeTiers` is configured and this
   * merchant's trailing current-calendar-month SUCCEEDED volume (in the
   * same currency as `amount` — see PaymentRepositoryPort.sumSucceededVolumeSince()'s
   * docblock) has reached a tier's threshold, in which case that tier's
   * rate applies instead. Volume is computed *before* this charge (it
   * hasn't been booked yet at this point in the saga), so the charge that
   * actually crosses a threshold still bills at the previous tier — the
   * next one gets the new rate. `feeTiers` is validated ascending at write
   * time (MerchantService.updateFeeTiers()), so the last tier whose
   * threshold the volume has reached is simply the last one matched
   * scanning in order.
   */
  private async resolvePlatformFeeBps(merchant: MerchantEntity | null, amount: Money): Promise<number> {
    const baseBps = merchant?.platformFeeBps ?? DEFAULT_PLATFORM_FEE_BPS;
    if (!merchant?.feeTiers || merchant.feeTiers.length === 0) {
      return baseBps;
    }

    const now = new Date();
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const volume = await this.paymentRepository.sumSucceededVolumeSince(
      merchant.merchantId,
      startOfMonth,
      amount.currency.code,
    );

    let bps = baseBps;
    for (const tier of merchant.feeTiers) {
      if (volume >= BigInt(tier.minVolumeMinorUnits)) {
        bps = tier.bps;
      } else {
        break;
      }
    }
    return bps;
  }

  /**
   * A split recipient's own settlement-currency conversion is independent
   * of the charging merchant's — a lookup failure here only drops *that*
   * recipient back to charge-currency booking (same fallback posture as
   * the charging merchant's own conversion below), it never blocks the
   * other splits or the remainder from converting.
   */
  private async resolveSplitConversion(
    recipientMerchantId: string,
    splitAmount: Money,
  ): Promise<{ convertedAmount: Money; rate: number; provider: string } | undefined> {
    const recipient = await this.merchantService.findByMerchantId(recipientMerchantId);
    const settlementCurrency = recipient?.settlementCurrency;
    if (!settlementCurrency || settlementCurrency === splitAmount.currency.code) {
      return undefined;
    }
    try {
      const { rate, provider } = await this.fxRateProvider.getRate(splitAmount.currency.code, settlementCurrency);
      return { convertedAmount: splitAmount.convertTo(settlementCurrency, rate, provider), rate, provider };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `FX conversion to ${settlementCurrency} failed for split recipient ${recipientMerchantId}, booking in ${splitAmount.currency.code} instead: ${msg}`,
      );
      return undefined;
    }
  }

  /**
   * `requestedSplits` — the marketplace `splits` a charge request asked
   * for, if any. Validated here, *before* the caller ever calls the PSP
   * (see PaymentCheckoutSaga.execute()'s docblock for why this method is
   * called up front rather than after a successful charge) — an invalid
   * split (unknown/non-connected recipient, or total exceeding the net
   * payout) throws here rather than leaving a charged-but-unbooked payment
   * behind. A split recipient with their own `settlementCurrency` gets
   * their own independent FX conversion (see resolveSplitConversion());
   * the charging merchant's own `settlementCurrency` (if set) converts
   * whatever's left after all splits are carved out — the two no longer
   * exclude each other, and may use different rates/currencies.
   */
  async resolve(
    merchantId: string,
    amount: Money,
    requestedSplits?: { merchantId: string; amount: Money }[],
  ): Promise<ChargeLedgerParams> {
    const merchant = await this.merchantService.findByMerchantId(merchantId);
    const enabledPspProviders = merchant?.enabledPspProviders as PSPProvider[] | undefined;
    const platformFeeBps = await this.resolvePlatformFeeBps(merchant, amount);
    const platformFee = amount.multiply(platformFeeBps / 10_000);
    const netAmount = amount.subtract(platformFee);

    let reserveHold: ChargeLedgerParams['reserveHold'];
    let payoutAmount = netAmount;
    if (merchant?.reserveBps) {
      const reserveAmount = netAmount.multiply(merchant.reserveBps / 10_000);
      reserveHold = { amount: reserveAmount, holdDays: merchant.reserveHoldDays, netAmount };
      payoutAmount = netAmount.subtract(reserveAmount);
    }

    let splits: ChargeLedgerParams['splits'];
    let remainderAmount = payoutAmount;
    if (requestedSplits && requestedSplits.length > 0) {
      let splitTotal = Money.zero(amount.currency.code);
      for (const split of requestedSplits) {
        const recipient = await this.merchantService.findByMerchantId(split.merchantId);
        if (!recipient || recipient.accountType !== 'CONNECTED' || recipient.platformMerchantId !== merchantId) {
          throw new UnprocessableEntityException({
            statusCode: 422,
            error: `${split.merchantId} is not an active connected account of ${merchantId}`,
            code: 'SPLIT_RECIPIENT_INVALID',
          });
        }
        splitTotal = splitTotal.add(split.amount);
      }
      if (splitTotal.isGreaterThan(payoutAmount)) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          error: `Split total ${splitTotal.toString()} exceeds the net payout amount ${payoutAmount.toString()}`,
          code: 'SPLIT_EXCEEDS_NET_AMOUNT',
        });
      }
      remainderAmount = payoutAmount.subtract(splitTotal);
      splits = await Promise.all(
        requestedSplits.map(async (split) => ({
          ...split,
          settlementConversion: await this.resolveSplitConversion(split.merchantId, split.amount),
        })),
      );
    }

    const settlementCurrency = merchant?.settlementCurrency;
    if (!settlementCurrency || settlementCurrency === amount.currency.code) {
      return { platformFee, reserveHold, splits, enabledPspProviders };
    }

    try {
      const { rate, provider } = await this.fxRateProvider.getRate(amount.currency.code, settlementCurrency);
      const convertedNetAmount = remainderAmount.convertTo(settlementCurrency, rate, provider);
      return {
        platformFee,
        reserveHold,
        splits,
        settlementConversion: { convertedNetAmount, rate, provider },
        enabledPspProviders,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `FX conversion to ${settlementCurrency} failed for merchant ${merchantId}, booking in ${amount.currency.code} instead: ${msg}`,
      );
      return { platformFee, reserveHold, splits, enabledPspProviders };
    }
  }
}

/**
 * Normalizes `ChargeLedgerParams.splits` (this service's booking shape —
 * `settlementConversion: {convertedAmount: Money, rate, provider}`, the
 * form `LedgerOutboxEvent.createChargeEntries()` needs) into
 * `PaymentSplit[]` (the aggregate/persistence shape —
 * `settlementConversion: {currency: string, rate, provider}`, no
 * `convertedAmount` — the rate/currency is enough to replay a conversion
 * later, the amount itself is re-derived from whatever's being refunded).
 * Shared by every call site that calls `PaymentAggregate.recordSplits()`/
 * `finalizeSplitConversions()`, so this mapping exists in exactly one
 * place.
 */
export function toPaymentSplits(splits: ChargeLedgerParams['splits']): PaymentSplit[] {
  return (splits ?? []).map((split) => ({
    merchantId: split.merchantId,
    amount: split.amount,
    settlementConversion: split.settlementConversion
      ? {
          currency: split.settlementConversion.convertedAmount.currency.code,
          rate: split.settlementConversion.rate,
          provider: split.settlementConversion.provider,
        }
      : undefined,
  }));
}
