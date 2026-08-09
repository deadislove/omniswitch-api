import { Injectable, Logger, ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { Money } from '../../domain/value-objects/money.vo';
import { MerchantEntity } from '../../../merchant/merchant.entity';
import { MerchantService } from '../../../merchant/merchant.service';
import { FXRateProviderPort } from '../../ports/outbound/fx-rate-provider.port';
import { PaymentRepositoryPort } from '../../ports/outbound/payment-repository.port';

// Fallback only for the (shouldn't-happen) case of no merchant record —
// every caller of this service already only runs for an authenticated,
// JWT-bearing merchant or a payment created by one, so this is defensive,
// not a real code path. Matches the default MerchantEntity.platformFeeBps
// carries for every merchant created without an explicit rate.
const DEFAULT_PLATFORM_FEE_BPS = 150;

export interface ChargeLedgerParams {
  platformFee: Money;
  settlementConversion?: { convertedNetAmount: Money; rate: number; provider: string };
  reserveHold?: { amount: Money; holdDays: number };
  splits?: { merchantId: string; amount: Money }[];
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
    const volume = await this.paymentRepository.sumSucceededVolumeSince(merchant.merchantId, startOfMonth, amount.currency.code);

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
   * `requestedSplits` — the marketplace `splits` a charge request asked
   * for, if any. Validated here, *before* the caller ever calls the PSP
   * (see PaymentCheckoutSaga.execute()'s docblock for why this method is
   * called up front rather than after a successful charge) — an invalid
   * split (unknown/non-connected recipient, total exceeding the net
   * payout, or a merchant with an active settlement-currency conversion)
   * throws here rather than leaving a charged-but-unbooked payment behind.
   */
  async resolve(merchantId: string, amount: Money, requestedSplits?: { merchantId: string; amount: Money }[]): Promise<ChargeLedgerParams> {
    const merchant = await this.merchantService.findByMerchantId(merchantId);
    const platformFeeBps = await this.resolvePlatformFeeBps(merchant, amount);
    const platformFee = amount.multiply(platformFeeBps / 10_000);
    const netAmount = amount.subtract(platformFee);

    let reserveHold: ChargeLedgerParams['reserveHold'];
    let payoutAmount = netAmount;
    if (merchant?.reserveBps) {
      const reserveAmount = netAmount.multiply(merchant.reserveBps / 10_000);
      reserveHold = { amount: reserveAmount, holdDays: merchant.reserveHoldDays };
      payoutAmount = netAmount.subtract(reserveAmount);
    }

    let splits: ChargeLedgerParams['splits'];
    if (requestedSplits && requestedSplits.length > 0) {
      if (merchant?.settlementCurrency && merchant.settlementCurrency !== amount.currency.code) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Marketplace splits are not supported together with a merchant settlement-currency conversion',
          code: 'SPLIT_WITH_SETTLEMENT_CONVERSION_UNSUPPORTED',
        });
      }
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
      splits = requestedSplits;
    }

    const settlementCurrency = merchant?.settlementCurrency;
    if (!settlementCurrency || settlementCurrency === amount.currency.code) {
      return { platformFee, reserveHold, splits };
    }

    try {
      const { rate, provider } = await this.fxRateProvider.getRate(amount.currency.code, settlementCurrency);
      const convertedNetAmount = payoutAmount.convertTo(settlementCurrency, rate, provider);
      return { platformFee, reserveHold, settlementConversion: { convertedNetAmount, rate, provider } };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `FX conversion to ${settlementCurrency} failed for merchant ${merchantId}, booking in ${amount.currency.code} instead: ${msg}`,
      );
      return { platformFee, reserveHold };
    }
  }
}
