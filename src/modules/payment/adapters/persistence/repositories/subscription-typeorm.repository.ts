import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Not, Repository } from 'typeorm';
import { SubscriptionPort, FindSubscriptionsFilter } from '../../../ports/outbound/subscription.port';
import { Subscription } from '../../../domain/aggregates/subscription.aggregate';
import { Money } from '../../../domain/value-objects/money.vo';
import { SubscriptionEntity } from '../entities/subscription.entity';

@Injectable()
export class SubscriptionTypeOrmRepository implements SubscriptionPort {
  constructor(
    @InjectRepository(SubscriptionEntity)
    private readonly repo: Repository<SubscriptionEntity>,
  ) {}

  async save(subscription: Subscription): Promise<void> {
    const entity = new SubscriptionEntity();
    entity.id = subscription.id;
    entity.merchantId = subscription.merchantId;
    entity.customerId = subscription.customerId;
    entity.amountMinorUnits = subscription.amount.amountMinorUnits.toString();
    entity.currencyCode = subscription.amount.currency.code;
    entity.interval = subscription.interval;
    entity.intervalCount = subscription.intervalCount;
    entity.paymentMethodId = subscription.paymentMethodId;
    entity.status = subscription.status;
    entity.currentPeriodStart = subscription.currentPeriodStart;
    entity.currentPeriodEnd = subscription.currentPeriodEnd;
    entity.cancelAtPeriodEnd = subscription.cancelAtPeriodEnd;
    entity.failedAttempts = subscription.failedAttempts;
    entity.orderId = subscription.orderId;
    entity.description = subscription.description;
    entity.canceledAt = subscription.canceledAt ?? null;
    entity.planId = subscription.planId ?? null;
    entity.pendingCreditMinorUnits = subscription.pendingCredit ? subscription.pendingCredit.amountMinorUnits.toString() : null;
    entity.nextRetryAt = subscription.nextRetryAt ?? null;
    entity.lastDeclineCode = subscription.lastDeclineCode ?? null;
    await this.repo.save(entity);
  }

  async findById(id: string): Promise<Subscription | null> {
    const entity = await this.repo.findOne({ where: { id } });
    return entity ? this.toDomain(entity) : null;
  }

  async findMany(filter?: FindSubscriptionsFilter): Promise<Subscription[]> {
    const qb = this.repo.createQueryBuilder('s');
    if (filter?.merchantId) {
      qb.andWhere('s.merchantId = :merchantId', { merchantId: filter.merchantId });
    }
    if (filter?.customerId) {
      qb.andWhere('s.customerId = :customerId', { customerId: filter.customerId });
    }
    if (filter?.status) {
      qb.andWhere('s.status = :status', { status: filter.status });
    }
    qb.orderBy('s.createdAt', 'DESC').take(filter?.limit ?? 50);
    const entities = await qb.getMany();
    return entities.map((e) => this.toDomain(e));
  }

  async findDue(now: Date): Promise<Subscription[]> {
    const entities = await this.repo.find({
      where: { status: Not('CANCELED'), currentPeriodEnd: LessThanOrEqual(now) },
      order: { currentPeriodEnd: 'ASC' },
    });
    return entities.map((e) => this.toDomain(e));
  }

  private toDomain(entity: SubscriptionEntity): Subscription {
    return Subscription.reconstitute({
      id: entity.id,
      merchantId: entity.merchantId,
      customerId: entity.customerId,
      amount: Money.fromMinorUnits(BigInt(entity.amountMinorUnits), entity.currencyCode),
      interval: entity.interval,
      intervalCount: entity.intervalCount,
      paymentMethodId: entity.paymentMethodId,
      status: entity.status,
      currentPeriodStart: entity.currentPeriodStart,
      currentPeriodEnd: entity.currentPeriodEnd,
      cancelAtPeriodEnd: entity.cancelAtPeriodEnd,
      failedAttempts: entity.failedAttempts,
      orderId: entity.orderId,
      description: entity.description,
      canceledAt: entity.canceledAt ?? undefined,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      planId: entity.planId ?? undefined,
      pendingCredit: entity.pendingCreditMinorUnits != null ? Money.fromMinorUnits(BigInt(entity.pendingCreditMinorUnits), entity.currencyCode) : undefined,
      nextRetryAt: entity.nextRetryAt ?? undefined,
      lastDeclineCode: entity.lastDeclineCode ?? undefined,
    });
  }
}
