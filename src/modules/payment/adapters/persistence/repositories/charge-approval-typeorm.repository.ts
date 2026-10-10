import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, SelectQueryBuilder } from 'typeorm';
import { ChargeApprovalPort, FindChargeApprovalsFilter } from '../../../ports/outbound/charge-approval.port';
import { ChargeApproval } from '../../../domain/aggregates/charge-approval.aggregate';
import { Money } from '../../../domain/value-objects/money.vo';
import { ChargeApprovalEntity } from '../entities/charge-approval.entity';

@Injectable()
export class ChargeApprovalTypeOrmRepository implements ChargeApprovalPort {
  constructor(
    @InjectRepository(ChargeApprovalEntity)
    private readonly repo: Repository<ChargeApprovalEntity>,
    private readonly dataSource: DataSource,
  ) {}

  async save(approval: ChargeApproval): Promise<void> {
    const entity = new ChargeApprovalEntity();
    entity.id = approval.id;
    entity.paymentId = approval.paymentId;
    entity.delegationId = approval.delegationId;
    entity.merchantId = approval.merchantId;
    entity.amountMinorUnits = approval.amount.amountMinorUnits.toString();
    entity.currencyCode = approval.amount.currency.code;
    entity.idempotencyKey = approval.idempotencyKey;
    entity.chargeRequest = approval.chargeRequest;
    entity.status = approval.status;
    entity.decidedAt = approval.decidedAt ?? null;
    entity.decidedBy = approval.decidedBy ?? null;
    entity.denialReason = approval.denialReason ?? null;
    await this.repo.save(entity);
  }

  async findById(id: string): Promise<ChargeApproval | null> {
    const entity = await this.repo.findOne({ where: { id } });
    return entity ? this.toDomain(entity) : null;
  }

  // See ChargeApprovalPort.findByIdOnMaster()'s docblock for why this is
  // forced onto master rather than the ambient replica-routed connection.
  async findByIdOnMaster(id: string): Promise<ChargeApproval | null> {
    const queryRunner = this.dataSource.createQueryRunner('master');
    let entity: ChargeApprovalEntity | null;
    try {
      entity = await queryRunner.manager.findOne(ChargeApprovalEntity, { where: { id } });
    } finally {
      await queryRunner.release();
    }
    return entity ? this.toDomain(entity) : null;
  }

  async findMany(filter?: FindChargeApprovalsFilter): Promise<ChargeApproval[]> {
    return this.runFindMany(this.repo.createQueryBuilder('c'), filter);
  }

  // See ChargeApprovalPort.findManyOnMaster()'s docblock — same reasoning
  // as findByIdOnMaster().
  async findManyOnMaster(filter?: FindChargeApprovalsFilter): Promise<ChargeApproval[]> {
    const queryRunner = this.dataSource.createQueryRunner('master');
    try {
      return await this.runFindMany(queryRunner.manager.createQueryBuilder(ChargeApprovalEntity, 'c'), filter);
    } finally {
      await queryRunner.release();
    }
  }

  private async runFindMany(
    qb: SelectQueryBuilder<ChargeApprovalEntity>,
    filter?: FindChargeApprovalsFilter,
  ): Promise<ChargeApproval[]> {
    if (filter?.merchantId) {
      qb.andWhere('c.merchantId = :merchantId', { merchantId: filter.merchantId });
    }
    if (filter?.delegationId) {
      qb.andWhere('c.delegationId = :delegationId', { delegationId: filter.delegationId });
    }
    if (filter?.status) {
      qb.andWhere('c.status = :status', { status: filter.status });
    }
    qb.orderBy('c.createdAt', 'DESC').take(filter?.limit ?? 50);
    const entities = await qb.getMany();
    return entities.map((e) => this.toDomain(e));
  }

  async markApproved(id: string, now: Date, decidedBy: string): Promise<boolean> {
    const result = await this.repo
      .createQueryBuilder()
      .update(ChargeApprovalEntity)
      .set({ status: 'APPROVED', decidedAt: now, decidedBy })
      .where('id = :id', { id })
      .andWhere('status = :pending', { pending: 'PENDING' })
      .execute();
    return (result.affected ?? 0) > 0;
  }

  async markDenied(id: string, now: Date, decidedBy: string, reason?: string): Promise<boolean> {
    const result = await this.repo
      .createQueryBuilder()
      .update(ChargeApprovalEntity)
      .set({ status: 'DENIED', decidedAt: now, decidedBy, denialReason: reason ?? null })
      .where('id = :id', { id })
      .andWhere('status = :pending', { pending: 'PENDING' })
      .execute();
    return (result.affected ?? 0) > 0;
  }

  private toDomain(entity: ChargeApprovalEntity): ChargeApproval {
    return ChargeApproval.reconstitute({
      id: entity.id,
      paymentId: entity.paymentId,
      delegationId: entity.delegationId,
      merchantId: entity.merchantId,
      amount: Money.fromMinorUnits(BigInt(entity.amountMinorUnits), entity.currencyCode),
      idempotencyKey: entity.idempotencyKey,
      chargeRequest: entity.chargeRequest,
      status: entity.status,
      createdAt: entity.createdAt,
      decidedAt: entity.decidedAt ?? undefined,
      decidedBy: entity.decidedBy ?? undefined,
      denialReason: entity.denialReason ?? undefined,
    });
  }
}
