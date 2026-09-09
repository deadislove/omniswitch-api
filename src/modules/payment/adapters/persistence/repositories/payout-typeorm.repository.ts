import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
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
    private readonly dataSource: DataSource,
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
    entity.reserveTransferStatus = payout.reserveTransferStatus;
    entity.reserveTransferId = payout.reserveTransferId ?? null;
    entity.reserveTransferInitiatedAt = payout.reserveTransferInitiatedAt ?? null;
    entity.reserveTransferError = payout.reserveTransferError ?? null;
    await this.payoutRepo.save(entity);
  }

  async findById(id: string): Promise<Payout | null> {
    const entity = await this.payoutRepo.findOne({ where: { id } });
    return entity ? this.toDomain(entity) : null;
  }

  // See PayoutPort.findByIdOnMaster()'s docblock for why this is forced
  // onto master.
  async findByIdOnMaster(id: string): Promise<Payout | null> {
    const queryRunner = this.dataSource.createQueryRunner('master');
    try {
      const entity = await queryRunner.manager.findOne(PayoutEntity, { where: { id } });
      return entity ? this.toDomain(entity) : null;
    } finally {
      await queryRunner.release();
    }
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

  // See PayoutPort.findManyOnMaster()'s docblock for why this is forced
  // onto master.
  async findManyOnMaster(filter?: FindPayoutsFilter): Promise<Payout[]> {
    const queryRunner = this.dataSource.createQueryRunner('master');
    let entities: PayoutEntity[];
    try {
      const qb = queryRunner.manager.createQueryBuilder(PayoutEntity, 'p');
      if (filter?.merchantId) {
        qb.andWhere('p.merchantId = :merchantId', { merchantId: filter.merchantId });
      }
      qb.orderBy('p.createdAt', 'DESC').take(filter?.limit ?? 50);
      entities = await qb.getMany();
    } finally {
      await queryRunner.release();
    }
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
      .andWhere('p.transferStatus NOT IN (:...excluded)', { excluded: ['INITIATED', 'PENDING_CONFIRMATION'] })
      .orderBy('p.createdAt', 'ASC')
      .getMany();
    return entities.map((e) => this.toDomain(e));
  }

  async markTransferPending(id: string, transferId: string, submittedAt: Date): Promise<boolean> {
    const result = await this.payoutRepo
      .createQueryBuilder()
      .update(PayoutEntity)
      .set({
        transferStatus: 'PENDING_CONFIRMATION',
        transferId,
        transferInitiatedAt: submittedAt,
        transferError: () => 'NULL',
      })
      .where('id = :id', { id })
      .andWhere('transferStatus NOT IN (:...excluded)', { excluded: ['INITIATED', 'PENDING_CONFIRMATION'] })
      .execute();
    return (result.affected ?? 0) > 0;
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

  async findByTransferId(transferId: string): Promise<Payout | null> {
    const entity = await this.payoutRepo.findOne({ where: { transferId } });
    return entity ? this.toDomain(entity) : null;
  }

  // See PayoutPort.findByTransferIdOnMaster()'s docblock for why this is
  // forced onto master.
  async findByTransferIdOnMaster(transferId: string): Promise<Payout | null> {
    const queryRunner = this.dataSource.createQueryRunner('master');
    try {
      const entity = await queryRunner.manager.findOne(PayoutEntity, { where: { transferId } });
      return entity ? this.toDomain(entity) : null;
    } finally {
      await queryRunner.release();
    }
  }

  async findReserveTransferEligible(): Promise<Payout[]> {
    const entities = await this.payoutRepo
      .createQueryBuilder('p')
      .where('p.kycBlocked = false')
      .andWhere('p.reserveReleased = true')
      .andWhere('p.reserveAmountMinorUnits > 0')
      .andWhere('p.reserveTransferStatus NOT IN (:...excluded)', { excluded: ['INITIATED', 'PENDING_CONFIRMATION'] })
      .orderBy('p.reserveReleasedAt', 'ASC')
      .getMany();
    return entities.map((e) => this.toDomain(e));
  }

  async markReserveTransferPending(id: string, transferId: string, submittedAt: Date): Promise<boolean> {
    const result = await this.payoutRepo
      .createQueryBuilder()
      .update(PayoutEntity)
      .set({
        reserveTransferStatus: 'PENDING_CONFIRMATION',
        reserveTransferId: transferId,
        reserveTransferInitiatedAt: submittedAt,
        reserveTransferError: () => 'NULL',
      })
      .where('id = :id', { id })
      .andWhere('reserveTransferStatus NOT IN (:...excluded)', { excluded: ['INITIATED', 'PENDING_CONFIRMATION'] })
      .execute();
    return (result.affected ?? 0) > 0;
  }

  async markReserveTransferInitiated(id: string, transferId: string, initiatedAt: Date): Promise<boolean> {
    const result = await this.payoutRepo
      .createQueryBuilder()
      .update(PayoutEntity)
      .set({
        reserveTransferStatus: 'INITIATED',
        reserveTransferId: transferId,
        reserveTransferInitiatedAt: initiatedAt,
        reserveTransferError: () => 'NULL',
      })
      .where('id = :id', { id })
      .andWhere('reserveTransferStatus != :initiated', { initiated: 'INITIATED' })
      .execute();
    return (result.affected ?? 0) > 0;
  }

  async markReserveTransferFailed(id: string, error: string): Promise<void> {
    await this.payoutRepo.update(id, { reserveTransferStatus: 'FAILED', reserveTransferError: error });
  }

  async findByReserveTransferId(transferId: string): Promise<Payout | null> {
    const entity = await this.payoutRepo.findOne({ where: { reserveTransferId: transferId } });
    return entity ? this.toDomain(entity) : null;
  }

  // See PayoutPort.findByReserveTransferIdOnMaster()'s docblock for why
  // this is forced onto master.
  async findByReserveTransferIdOnMaster(transferId: string): Promise<Payout | null> {
    const queryRunner = this.dataSource.createQueryRunner('master');
    try {
      const entity = await queryRunner.manager.findOne(PayoutEntity, { where: { reserveTransferId: transferId } });
      return entity ? this.toDomain(entity) : null;
    } finally {
      await queryRunner.release();
    }
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

  // Forced onto master, same reasoning as MerchantService's
  // findMerchantOnMaster()/list() — this gates runSweepLocked()'s
  // windowStart. The SETNX lock in PayoutService.runSweep() only
  // serializes concurrent sweeps against each other; it doesn't stop a
  // *later*, already-serialized sweep from reading a stale (pre-replication)
  // "no prior run" here and re-processing a window the previous sweep
  // already paid out — a real duplicate Payout, not just a stale read.
  // Confirmed via a real e2e failure (marketplace-payouts.e2e-spec.ts)
  // that only reproduced under concurrent e2e load, never in isolation.
  async findLatestSweepRun(): Promise<PayoutSweepRun | null> {
    const queryRunner = this.dataSource.createQueryRunner('master');
    let entity: PayoutSweepRunEntity | null;
    try {
      entity = await queryRunner.manager.findOne(PayoutSweepRunEntity, { where: {}, order: { windowEnd: 'DESC' } });
    } finally {
      await queryRunner.release();
    }
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
      reserveTransferStatus: entity.reserveTransferStatus,
      reserveTransferId: entity.reserveTransferId ?? undefined,
      reserveTransferInitiatedAt: entity.reserveTransferInitiatedAt ?? undefined,
      reserveTransferError: entity.reserveTransferError ?? undefined,
    });
  }
}
