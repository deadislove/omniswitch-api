import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';
import { PayoutPort, FindPayoutsFilter } from '../../../ports/outbound/payout.port';
import { Payout } from '../../../domain/aggregates/payout.aggregate';
import { PayoutSweepRun } from '../../../domain/aggregates/payout-sweep-run.aggregate';
import { Money } from '../../../domain/value-objects/money.vo';
import { PayoutEntity } from '../entities/payout.entity';
import { PayoutSweepRunEntity } from '../entities/payout-sweep-run.entity';

@Injectable()
export class PayoutTypeOrmRepository implements PayoutPort {
  constructor(
    @InjectRepository(PayoutEntity)
    private readonly payoutRepo: Repository<PayoutEntity>,
    @InjectRepository(PayoutSweepRunEntity)
    private readonly sweepRunRepo: Repository<PayoutSweepRunEntity>,
  ) {}

  async save(payout: Payout): Promise<void> {
    const entity = new PayoutEntity();
    entity.id = payout.id;
    entity.merchantId = payout.merchantId;
    entity.sweepRunId = payout.sweepRunId;
    entity.grossAmountMinorUnits = payout.grossAmount.amountMinorUnits.toString();
    entity.reserveAmountMinorUnits = payout.reserveAmount.amountMinorUnits.toString();
    entity.netAmountMinorUnits = payout.netAmount.amountMinorUnits.toString();
    entity.currencyCode = payout.grossAmount.currency.code;
    entity.releaseEligibleAt = payout.releaseEligibleAt ?? null;
    entity.reserveReleased = payout.reserveReleased;
    entity.reserveReleasedAt = payout.reserveReleasedAt ?? null;
    entity.kycBlocked = payout.kycBlocked;
    entity.kycClearedAt = payout.kycClearedAt ?? null;
    entity.transferStatus = payout.transferStatus;
    entity.transferId = payout.transferId ?? null;
    entity.transferInitiatedAt = payout.transferInitiatedAt ?? null;
    entity.transferError = payout.transferError ?? null;
    await this.payoutRepo.save(entity);
  }

  async findById(id: string): Promise<Payout | null> {
    const entity = await this.payoutRepo.findOne({ where: { id } });
    return entity ? this.toDomain(entity) : null;
  }

  async findMany(filter?: FindPayoutsFilter): Promise<Payout[]> {
    const qb = this.payoutRepo.createQueryBuilder('p');
    if (filter?.merchantId) {
      qb.andWhere('p.merchantId = :merchantId', { merchantId: filter.merchantId });
    }
    qb.orderBy('p.createdAt', 'DESC').take(filter?.limit ?? 50);
    const entities = await qb.getMany();
    return entities.map((e) => this.toDomain(e));
  }

  async findReserveReleaseEligible(now: Date): Promise<Payout[]> {
    const entities = await this.payoutRepo
      .createQueryBuilder('p')
      .where('p.reserveReleased = false')
      .andWhere('p.reserveAmountMinorUnits > 0')
      // .toISOString() — releaseEligibleAt is timestamptz already, but the
      // comparison param still needs to be an ISO string, not a raw JS
      // Date, for the same node-postgres serialization reason
      // findStale()/findByProviderAndDateRange() already document
      // elsewhere in this codebase.
      .andWhere('p.releaseEligibleAt <= :now', { now: now.toISOString() })
      .orderBy('p.releaseEligibleAt', 'ASC')
      .getMany();
    return entities.map((e) => this.toDomain(e));
  }

  async markReserveReleased(id: string, releasedAt: Date): Promise<boolean> {
    const result = await this.payoutRepo
      .createQueryBuilder()
      .update(PayoutEntity)
      .set({ reserveReleased: true, reserveReleasedAt: releasedAt })
      .where('id = :id', { id })
      .andWhere('reserveReleased = false')
      .execute();
    return (result.affected ?? 0) > 0;
  }

  async findKycBlocked(): Promise<Payout[]> {
    const entities = await this.payoutRepo.find({ where: { kycBlocked: true }, order: { createdAt: 'ASC' } });
    return entities.map((e) => this.toDomain(e));
  }

  async markKycCleared(id: string, clearedAt: Date): Promise<boolean> {
    const result = await this.payoutRepo
      .createQueryBuilder()
      .update(PayoutEntity)
      .set({ kycBlocked: false, kycClearedAt: clearedAt })
      .where('id = :id', { id })
      .andWhere('kycBlocked = true')
      .execute();
    return (result.affected ?? 0) > 0;
  }

  async findTransferEligible(): Promise<Payout[]> {
    const entities = await this.payoutRepo
      .createQueryBuilder('p')
      .where('p.kycBlocked = false')
      .andWhere('p.netAmountMinorUnits > 0')
      .andWhere('p.transferStatus != :initiated', { initiated: 'INITIATED' })
      .orderBy('p.createdAt', 'ASC')
      .getMany();
    return entities.map((e) => this.toDomain(e));
  }

  async markTransferInitiated(id: string, transferId: string, initiatedAt: Date): Promise<boolean> {
    const result = await this.payoutRepo
      .createQueryBuilder()
      .update(PayoutEntity)
      .set({ transferStatus: 'INITIATED', transferId, transferInitiatedAt: initiatedAt, transferError: () => 'NULL' })
      .where('id = :id', { id })
      .andWhere('transferStatus != :initiated', { initiated: 'INITIATED' })
      .execute();
    return (result.affected ?? 0) > 0;
  }

  async markTransferFailed(id: string, error: string): Promise<void> {
    await this.payoutRepo.update(id, { transferStatus: 'FAILED', transferError: error });
  }

  async saveSweepRun(run: PayoutSweepRun): Promise<void> {
    const entity = new PayoutSweepRunEntity();
    entity.id = run.id;
    entity.windowStart = run.windowStart;
    entity.windowEnd = run.windowEnd;
    entity.connectedMerchantsPaid = run.connectedMerchantsPaid;
    entity.ranAt = run.ranAt;
    await this.sweepRunRepo.save(entity);
  }

  async findLatestSweepRun(): Promise<PayoutSweepRun | null> {
    const entity = await this.sweepRunRepo.findOne({ where: {}, order: { windowEnd: 'DESC' } });
    return entity
      ? PayoutSweepRun.reconstitute({
          id: entity.id,
          windowStart: entity.windowStart,
          windowEnd: entity.windowEnd,
          connectedMerchantsPaid: entity.connectedMerchantsPaid,
          ranAt: entity.ranAt,
        })
      : null;
  }

  private toDomain(entity: PayoutEntity): Payout {
    return Payout.reconstitute({
      id: entity.id,
      merchantId: entity.merchantId,
      sweepRunId: entity.sweepRunId,
      grossAmount: Money.fromMinorUnits(BigInt(entity.grossAmountMinorUnits), entity.currencyCode),
      reserveAmount: Money.fromMinorUnits(BigInt(entity.reserveAmountMinorUnits), entity.currencyCode),
      netAmount: Money.fromMinorUnits(BigInt(entity.netAmountMinorUnits), entity.currencyCode),
      releaseEligibleAt: entity.releaseEligibleAt ?? undefined,
      reserveReleased: entity.reserveReleased,
      reserveReleasedAt: entity.reserveReleasedAt ?? undefined,
      createdAt: entity.createdAt,
      kycBlocked: entity.kycBlocked,
      kycClearedAt: entity.kycClearedAt ?? undefined,
      transferStatus: entity.transferStatus,
      transferId: entity.transferId ?? undefined,
      transferInitiatedAt: entity.transferInitiatedAt ?? undefined,
      transferError: entity.transferError ?? undefined,
    });
  }
}
