import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BnplOrderPort } from '../../../ports/outbound/bnpl-order.port';
import { BnplOrder, BnplRefundRecord } from '../../../domain/aggregates/bnpl-order.aggregate';
import { Money } from '../../../domain/value-objects/money.vo';
import { BnplOrderEntity } from '../entities/bnpl-order.entity';

@Injectable()
export class BnplOrderTypeOrmRepository implements BnplOrderPort {
  constructor(
    @InjectRepository(BnplOrderEntity)
    private readonly repo: Repository<BnplOrderEntity>,
  ) {}

  async save(order: BnplOrder): Promise<void> {
    const entity = new BnplOrderEntity();
    entity.id = order.id;
    entity.merchantId = order.merchantId;
    entity.amountMinorUnits = order.amount.amountMinorUnits.toString();
    entity.currencyCode = order.amount.currency.code;
    entity.idempotencyKey = order.idempotencyKey;
    entity.status = order.status;
    entity.customerId = order.customerId ?? null;
    entity.description = order.description ?? null;
    entity.providerOrderId = order.providerOrderId ?? null;
    entity.providerCaptureId = order.providerCaptureId ?? null;
    entity.failureReason = order.failureReason ?? null;
    entity.refunds = order.refunds.map((r) => ({
      refundId: r.refundId,
      amountMinorUnits: r.amount.amountMinorUnits.toString(),
      reason: r.reason,
      createdAt: r.createdAt.toISOString(),
      providerRefundId: r.providerRefundId,
    }));
    entity.capturedAt = order.capturedAt ?? null;
    await this.repo.save(entity);
  }

  async findById(id: string): Promise<BnplOrder | null> {
    const entity = await this.repo.findOne({ where: { id } });
    return entity ? this.toDomain(entity) : null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<BnplOrder | null> {
    const entity = await this.repo.findOne({ where: { idempotencyKey } });
    return entity ? this.toDomain(entity) : null;
  }

  private toDomain(entity: BnplOrderEntity): BnplOrder {
    const refunds: BnplRefundRecord[] = (entity.refunds ?? []).map((r: any) => ({
      refundId: r.refundId,
      amount: Money.fromMinorUnits(BigInt(r.amountMinorUnits), entity.currencyCode),
      reason: r.reason,
      createdAt: new Date(r.createdAt),
      providerRefundId: r.providerRefundId,
    }));

    return BnplOrder.reconstitute({
      id: entity.id,
      merchantId: entity.merchantId,
      amount: Money.fromMinorUnits(BigInt(entity.amountMinorUnits), entity.currencyCode),
      idempotencyKey: entity.idempotencyKey,
      status: entity.status,
      customerId: entity.customerId ?? undefined,
      description: entity.description ?? undefined,
      providerOrderId: entity.providerOrderId ?? undefined,
      providerCaptureId: entity.providerCaptureId ?? undefined,
      failureReason: entity.failureReason ?? undefined,
      refunds,
      createdAt: entity.createdAt,
      capturedAt: entity.capturedAt ?? undefined,
    });
  }
}
