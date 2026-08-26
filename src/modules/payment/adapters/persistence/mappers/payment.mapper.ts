import { PaymentAggregate, PSPProvider, ThreeDSResult, RefundRecord, CaptureRecord, PaymentSplit } from '../../../domain/aggregates/payment.aggregate';
import { PaymentEntity } from '../entities/payment.entity';
import { Money } from '../../../domain/value-objects/money.vo';
import { Currency } from '../../../domain/value-objects/currency.vo';
import { PaymentStatus } from '../../../domain/value-objects/payment-status.vo';
import { BinInfo, CardBrand, CardType } from '../../../domain/value-objects/bin-info.vo';

/**
 * Payment Mapper
 * Converts between PaymentAggregate (domain) and PaymentEntity (persistence).
 * Keeps domain model clean from ORM concerns.
 */
export class PaymentMapper {
  static toDomain(entity: PaymentEntity): PaymentAggregate {
    const currency = Currency.of(entity.currencyCode);
    const amount = Money.fromMinorUnits(
      BigInt(entity.amountMinorUnits),
      entity.currencyCode,
      entity.fxSnapshot as any,
    );

    let binInfo: BinInfo | undefined;
    if (entity.binInfo) {
      const b = entity.binInfo as any;
      binInfo = new BinInfo({
        bin: b.bin,
        country: b.country,
        cardBrand: b.cardBrand as CardBrand,
        cardType: b.cardType as CardType,
        issuingBank: b.issuingBank,
      });
    }

    const refunds: RefundRecord[] = (entity.refunds || []).map((r: any) => ({
      refundId: r.refundId,
      amount: Money.fromMinorUnits(BigInt(r.amountMinorUnits), r.currencyCode),
      reason: r.reason,
      createdAt: new Date(r.createdAt),
      pspRefundId: r.pspRefundId,
    }));

    const captures: CaptureRecord[] = (entity.captures || []).map((c: any) => ({
      captureId: c.captureId,
      amount: Money.fromMinorUnits(BigInt(c.amountMinorUnits), c.currencyCode),
      createdAt: new Date(c.createdAt),
      pspCaptureId: c.pspCaptureId,
    }));

    const splits: PaymentSplit[] | undefined = entity.splits
      ? entity.splits.map((s) => ({ merchantId: s.merchantId, amount: Money.fromMinorUnits(BigInt(s.amountMinorUnits), s.currencyCode) }))
      : undefined;

    return PaymentAggregate.reconstitute({
      id: entity.id,
      amount,
      status: entity.status as PaymentStatus,
      idempotencyKey: entity.idempotencyKey,
      metadata: {
        merchantId: entity.merchantId,
        customerId: entity.customerId,
        orderId: entity.orderId,
        description: entity.description,
        statementDescriptor: entity.statementDescriptor,
        metadata: entity.paymentMetadata,
      },
      binInfo,
      pspProvider: entity.pspProvider as PSPProvider | undefined,
      pspTransactionId: entity.pspTransactionId,
      pspRawResponse: entity.pspRawResponse,
      riskScore: entity.riskScore,
      threeDSResult: entity.threeDSResult as ThreeDSResult | undefined,
      refunds,
      captures,
      failureReason: entity.failureReason,
      failureCode: entity.failureCode,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      settlementConversion: entity.settlementConversion ?? undefined,
      splits,
      ambiguousResolvedBy: entity.ambiguousResolvedBy,
      ambiguousResolvedReason: entity.ambiguousResolvedReason,
      ambiguousResolvedAt: entity.ambiguousResolvedAt,
      ambiguousAutoRetryCount: entity.ambiguousAutoRetryCount,
    });
  }

  static toPersistence(aggregate: PaymentAggregate): PaymentEntity {
    const entity = new PaymentEntity();
    entity.id = aggregate.id;
    entity.merchantId = aggregate.metadata.merchantId;
    entity.customerId = aggregate.metadata.customerId;
    entity.orderId = aggregate.metadata.orderId;
    entity.amountMinorUnits = aggregate.amount.amountMinorUnits.toString();
    entity.currencyCode = aggregate.amount.currency.code;
    entity.currencyMinorUnits = aggregate.amount.currency.minorUnits;
    entity.status = aggregate.status;
    entity.idempotencyKey = aggregate.idempotencyKey;
    entity.pspProvider = aggregate.pspProvider;
    entity.pspTransactionId = aggregate.pspTransactionId;
    entity.pspRawResponse = aggregate.pspRawResponse;
    entity.riskScore = aggregate.riskScore;
    entity.threeDSResult = aggregate.threeDSResult as any;
    entity.failureReason = aggregate.failureReason;
    entity.failureCode = aggregate.failureCode;
    entity.description = aggregate.metadata.description;
    entity.statementDescriptor = aggregate.metadata.statementDescriptor;
    entity.paymentMetadata = aggregate.metadata.metadata;
    entity.fxSnapshot = aggregate.amount.fxSnapshot as any;
    entity.settlementConversion = aggregate.settlementConversion;
    entity.ambiguousResolvedBy = aggregate.ambiguousResolvedBy;
    entity.ambiguousResolvedReason = aggregate.ambiguousResolvedReason;
    entity.ambiguousResolvedAt = aggregate.ambiguousResolvedAt;
    entity.ambiguousAutoRetryCount = aggregate.ambiguousAutoRetryCount;
    entity.splits = aggregate.splits?.map((s) => ({
      merchantId: s.merchantId,
      amountMinorUnits: s.amount.amountMinorUnits.toString(),
      currencyCode: s.amount.currency.code,
    }));

    if (aggregate.binInfo) {
      entity.binInfo = {
        bin: aggregate.binInfo.bin,
        country: aggregate.binInfo.country,
        cardBrand: aggregate.binInfo.cardBrand,
        cardType: aggregate.binInfo.cardType,
        issuingBank: aggregate.binInfo.issuingBank,
      };
    }

    entity.refunds = aggregate.refunds.map((r) => ({
      refundId: r.refundId,
      amountMinorUnits: r.amount.amountMinorUnits.toString(),
      currencyCode: r.amount.currency.code,
      reason: r.reason,
      createdAt: r.createdAt.toISOString(),
      pspRefundId: r.pspRefundId,
    }));

    entity.captures = aggregate.captures.map((c) => ({
      captureId: c.captureId,
      amountMinorUnits: c.amount.amountMinorUnits.toString(),
      currencyCode: c.amount.currency.code,
      createdAt: c.createdAt.toISOString(),
      pspCaptureId: c.pspCaptureId,
    }));

    return entity;
  }
}
