import { Money } from '../../domain/value-objects/money.vo';
import { BinInfo } from '../../domain/value-objects/bin-info.vo';
import { ChargePaymentDto } from '../dto/charge-payment.dto';
import { CheckoutSagaInput } from '../sagas/payment-checkout.saga';
import { PaymentInitiator } from '../../domain/aggregates/payment.aggregate';

/**
 * Derives `PaymentCheckoutSaga.execute()`'s input from a `ChargePaymentDto`
 * — extracted out of `PaymentController.charge()` so
 * `ChargeApprovalService.approve()` can replay the *exact* request a
 * `ChargeApproval` deferred, through the identical derivation the
 * immediate-execution path uses, rather than a second, drift-prone copy
 * of this logic. Pure and synchronous on purpose — no PSP/FX calls here,
 * so it works identically whether called seconds after the original
 * request or days later once a human approves it.
 */
export function buildCheckoutSagaInput(params: {
  paymentId: string;
  merchantId: string;
  idempotencyKey: string;
  dto: ChargePaymentDto;
  delegationId?: string;
  initiatedBy?: PaymentInitiator;
  agentPercentOfRemainingMonthlyBudget?: number;
}): CheckoutSagaInput {
  const {
    paymentId,
    merchantId,
    idempotencyKey,
    dto,
    delegationId,
    initiatedBy,
    agentPercentOfRemainingMonthlyBudget,
  } = params;
  const amount = Money.of(dto.amount, dto.currency);
  const splits = dto.splits?.map((s) => ({ merchantId: s.merchantId, amount: Money.of(s.amount, dto.currency) }));

  let binInfo: BinInfo | undefined;
  if (dto.binInfo) {
    binInfo = new BinInfo({
      bin: dto.binInfo.bin,
      country: dto.binInfo.country,
      cardBrand: dto.binInfo.cardBrand,
      cardType: dto.binInfo.cardType,
      issuingBank: dto.binInfo.issuingBank,
    });
  }

  return {
    paymentId,
    idempotencyKey,
    amount,
    merchantId,
    customerId: dto.customerId,
    orderId: dto.orderId,
    description: dto.description,
    statementDescriptor: dto.statementDescriptor,
    metadata: dto.metadata,
    binInfo,
    paymentMethodId: dto.paymentMethodId,
    cardToken: dto.cardToken,
    preferredProvider: dto.preferredProvider,
    captureMethod: dto.captureMethod,
    splits,
    delegationId,
    initiatedBy,
    agentPercentOfRemainingMonthlyBudget,
  };
}
