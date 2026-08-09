import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DelegationPort, FindDelegationsFilter } from '../../../ports/outbound/delegation.port';
import { Delegation, monthKeyOf } from '../../../domain/aggregates/delegation.aggregate';
import { SpendPolicy } from '../../../domain/value-objects/spend-policy.vo';
import { Money } from '../../../domain/value-objects/money.vo';
import { DelegationEntity } from '../entities/delegation.entity';

@Injectable()
export class DelegationTypeOrmRepository implements DelegationPort {
  constructor(
    @InjectRepository(DelegationEntity)
    private readonly repo: Repository<DelegationEntity>,
  ) {}

  async save(delegation: Delegation): Promise<void> {
    const entity = new DelegationEntity();
    entity.id = delegation.id;
    entity.merchantId = delegation.merchantId;
    entity.agentName = delegation.agentName;
    entity.perTransactionLimitMinorUnits = delegation.spendPolicy.perTransactionLimit.amountMinorUnits.toString();
    entity.monthlyLimitMinorUnits = delegation.spendPolicy.monthlyLimit.amountMinorUnits.toString();
    entity.currencyCode = delegation.spendPolicy.currency;
    entity.allowedCategories = delegation.spendPolicy.allowedCategories ?? null;
    entity.status = delegation.status;
    entity.currentMonthKey = delegation.currentMonthKey;
    entity.currentMonthSpentMinorUnits = delegation.currentMonthSpent.amountMinorUnits.toString();
    entity.jti = delegation.jti;
    entity.tokenExpiresAt = delegation.tokenExpiresAt;
    entity.revokedAt = delegation.revokedAt ?? null;
    await this.repo.save(entity);
  }

  async findById(id: string): Promise<Delegation | null> {
    const entity = await this.repo.findOne({ where: { id } });
    return entity ? this.toDomain(entity) : null;
  }

  async findMany(filter?: FindDelegationsFilter): Promise<Delegation[]> {
    const qb = this.repo.createQueryBuilder('d');
    if (filter?.merchantId) {
      qb.andWhere('d.merchantId = :merchantId', { merchantId: filter.merchantId });
    }
    if (filter?.status) {
      qb.andWhere('d.status = :status', { status: filter.status });
    }
    qb.orderBy('d.createdAt', 'DESC').take(filter?.limit ?? 50);
    const entities = await qb.getMany();
    return entities.map((e) => this.toDomain(e));
  }

  async tryReserveSpend(delegationId: string, amount: Money, now: Date): Promise<boolean> {
    const monthKey = monthKeyOf(now);
    const amountMinorUnits = amount.amountMinorUnits.toString();
    // Single row-locked UPDATE: rolls the month bucket over to `monthKey` if
    // it differs from what's stored, then increments — but only if the
    // resulting spend still fits the monthly cap and the amount alone fits
    // the per-transaction cap. Two concurrent charges against the same
    // delegation serialize on this row's lock, so the second one to commit
    // sees the first's already-reserved amount — the same atomic
    // conditional-update pattern this codebase already uses for
    // markReserveReleased()/markKycCleared()/markTransferInitiated(), just
    // with a computed (not merely boolean) WHERE condition.
    const result = await this.repo.manager.query(
      `UPDATE delegations
       SET current_month_spent_minor_units = (
             CASE WHEN current_month_key = $2 THEN current_month_spent_minor_units ELSE 0 END
           ) + $3,
           current_month_key = $2
       WHERE id = $1
         AND status = 'ACTIVE'
         AND $3::bigint <= per_transaction_limit_minor_units
         AND (
               CASE WHEN current_month_key = $2 THEN current_month_spent_minor_units ELSE 0 END
             ) + $3::bigint <= monthly_limit_minor_units
       RETURNING id`,
      [delegationId, monthKey, amountMinorUnits],
    );
    return Array.isArray(result) && result.length > 0;
  }

  async releaseSpend(delegationId: string, amount: Money): Promise<void> {
    await this.repo.manager.query(
      `UPDATE delegations
       SET current_month_spent_minor_units = GREATEST(current_month_spent_minor_units - $2::bigint, 0)
       WHERE id = $1`,
      [delegationId, amount.amountMinorUnits.toString()],
    );
  }

  private toDomain(entity: DelegationEntity): Delegation {
    const spendPolicy = SpendPolicy.create({
      perTransactionLimit: Money.fromMinorUnits(BigInt(entity.perTransactionLimitMinorUnits), entity.currencyCode),
      monthlyLimit: Money.fromMinorUnits(BigInt(entity.monthlyLimitMinorUnits), entity.currencyCode),
      allowedCategories: entity.allowedCategories ?? undefined,
    });
    return Delegation.reconstitute({
      id: entity.id,
      merchantId: entity.merchantId,
      agentName: entity.agentName,
      spendPolicy,
      status: entity.status,
      currentMonthKey: entity.currentMonthKey,
      currentMonthSpent: Money.fromMinorUnits(BigInt(entity.currentMonthSpentMinorUnits), entity.currencyCode),
      jti: entity.jti,
      tokenExpiresAt: entity.tokenExpiresAt,
      createdAt: entity.createdAt,
      revokedAt: entity.revokedAt ?? undefined,
      updatedAt: entity.updatedAt,
    });
  }
}
