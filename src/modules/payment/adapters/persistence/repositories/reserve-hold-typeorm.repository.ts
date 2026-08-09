import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';
import { ReserveHoldPort, FindReserveHoldsFilter } from '../../../ports/outbound/reserve-hold.port';
import { ReserveHold } from '../../../domain/aggregates/reserve-hold.aggregate';
import { Money } from '../../../domain/value-objects/money.vo';
import { ReserveHoldEntity } from '../entities/reserve-hold.entity';

@Injectable()
export class ReserveHoldTypeOrmRepository implements ReserveHoldPort {
  constructor(
    @InjectRepository(ReserveHoldEntity)
    private readonly repo: Repository<ReserveHoldEntity>,
  ) {}

  async save(hold: ReserveHold, transactionManager?: unknown): Promise<void> {
    const entity = new ReserveHoldEntity();
    entity.id = hold.id;
    entity.paymentId = hold.paymentId;
    entity.merchantId = hold.merchantId;
    entity.amountMinorUnits = hold.amount.amountMinorUnits.toString();
    entity.currencyCode = hold.amount.currency.code;
    entity.status = hold.status;
    entity.releaseEligibleAt = hold.releaseEligibleAt;
    entity.releasedAt = hold.releasedAt ?? null;

    if (transactionManager) {
      const repo = (transactionManager as any).getRepository(ReserveHoldEntity);
      await repo.save(entity);
    } else {
      await this.repo.save(entity);
    }
  }

  async findById(id: string): Promise<ReserveHold | null> {
    const entity = await this.repo.findOne({ where: { id } });
    return entity ? this.toDomain(entity) : null;
  }

  async findMany(filter?: FindReserveHoldsFilter): Promise<ReserveHold[]> {
    const qb = this.repo.createQueryBuilder('r');
    if (filter?.merchantId) {
      qb.andWhere('r.merchantId = :merchantId', { merchantId: filter.merchantId });
    }
    if (filter?.status) {
      qb.andWhere('r.status = :status', { status: filter.status });
    }
    qb.orderBy('r.createdAt', 'DESC').take(filter?.limit ?? 50);
    const entities = await qb.getMany();
    return entities.map((e) => this.toDomain(e));
  }

  async findReleaseEligible(now: Date): Promise<ReserveHold[]> {
    const entities = await this.repo.find({
      where: { status: 'HELD', releaseEligibleAt: LessThanOrEqual(now) },
      order: { releaseEligibleAt: 'ASC' },
    });
    return entities.map((e) => this.toDomain(e));
  }

  async markReleased(id: string, releasedAt: Date, transactionManager?: unknown): Promise<boolean> {
    const repo = transactionManager ? (transactionManager as any).getRepository(ReserveHoldEntity) : this.repo;
    const result = await repo
      .createQueryBuilder()
      .update(ReserveHoldEntity)
      .set({ status: 'RELEASED', releasedAt })
      .where('id = :id', { id })
      .andWhere('status = :status', { status: 'HELD' })
      .execute();
    return (result.affected ?? 0) > 0;
  }

  private toDomain(entity: ReserveHoldEntity): ReserveHold {
    return ReserveHold.reconstitute({
      id: entity.id,
      paymentId: entity.paymentId,
      merchantId: entity.merchantId,
      amount: Money.fromMinorUnits(BigInt(entity.amountMinorUnits), entity.currencyCode),
      status: entity.status,
      releaseEligibleAt: entity.releaseEligibleAt,
      createdAt: entity.createdAt,
      releasedAt: entity.releasedAt ?? undefined,
    });
  }
}
