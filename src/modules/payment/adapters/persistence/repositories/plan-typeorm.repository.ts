import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PlanPort, FindPlansFilter } from '../../../ports/outbound/plan.port';
import { Plan } from '../../../domain/aggregates/plan.aggregate';
import { Money } from '../../../domain/value-objects/money.vo';
import { PlanEntity } from '../entities/plan.entity';

@Injectable()
export class PlanTypeOrmRepository implements PlanPort {
  constructor(
    @InjectRepository(PlanEntity)
    private readonly repo: Repository<PlanEntity>,
  ) {}

  async save(plan: Plan): Promise<void> {
    const entity = new PlanEntity();
    entity.id = plan.id;
    entity.merchantId = plan.merchantId;
    entity.name = plan.name;
    entity.amountMinorUnits = plan.amount.amountMinorUnits.toString();
    entity.currencyCode = plan.amount.currency.code;
    entity.interval = plan.interval;
    entity.intervalCount = plan.intervalCount;
    entity.isActive = plan.isActive;
    await this.repo.save(entity);
  }

  async findById(id: string): Promise<Plan | null> {
    const entity = await this.repo.findOne({ where: { id } });
    return entity ? this.toDomain(entity) : null;
  }

  async findMany(filter?: FindPlansFilter): Promise<Plan[]> {
    const qb = this.repo.createQueryBuilder('p');
    if (filter?.merchantId) {
      qb.andWhere('p.merchantId = :merchantId', { merchantId: filter.merchantId });
    }
    if (filter?.isActive !== undefined) {
      qb.andWhere('p.isActive = :isActive', { isActive: filter.isActive });
    }
    qb.orderBy('p.createdAt', 'DESC').take(filter?.limit ?? 50);
    const entities = await qb.getMany();
    return entities.map((e) => this.toDomain(e));
  }

  private toDomain(entity: PlanEntity): Plan {
    return Plan.reconstitute({
      id: entity.id,
      merchantId: entity.merchantId,
      name: entity.name,
      amount: Money.fromMinorUnits(BigInt(entity.amountMinorUnits), entity.currencyCode),
      interval: entity.interval,
      intervalCount: entity.intervalCount,
      isActive: entity.isActive,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    });
  }
}
