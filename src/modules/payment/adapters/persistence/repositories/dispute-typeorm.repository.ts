import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { DisputePort, FindDisputesFilter } from '../../../ports/outbound/dispute.port';
import { Dispute, DisputeStatus } from '../../../domain/aggregates/dispute.aggregate';
import { Money } from '../../../domain/value-objects/money.vo';
import { DisputeEntity } from '../entities/dispute.entity';

@Injectable()
export class DisputeTypeOrmRepository implements DisputePort {
  constructor(
    @InjectRepository(DisputeEntity)
    private readonly repo: Repository<DisputeEntity>,
    private readonly dataSource: DataSource,
  ) {}

  async save(dispute: Dispute): Promise<void> {
    const entity = new DisputeEntity();
    entity.id = dispute.id;
    entity.paymentId = dispute.paymentId;
    entity.merchantId = dispute.merchantId;
    entity.pspProvider = dispute.pspProvider;
    entity.pspDisputeId = dispute.pspDisputeId;
    entity.amountMinorUnits = dispute.amount.amountMinorUnits.toString();
    entity.currencyCode = dispute.amount.currency.code;
    entity.reason = dispute.reason;
    entity.status = dispute.status;
    entity.respondBy = dispute.respondBy;
    entity.evidence = dispute.evidence;
    entity.autoDecision = dispute.autoDecision;
    await this.repo.save(entity);
  }

  async findById(id: string): Promise<Dispute | null> {
    const entity = await this.repo.findOne({ where: { id } });
    return entity ? this.toDomain(entity) : null;
  }

  async findByPspDisputeId(pspDisputeId: string): Promise<Dispute | null> {
    const entity = await this.repo.findOne({ where: { pspDisputeId } });
    return entity ? this.toDomain(entity) : null;
  }

  // Forced onto master, not the ambient replica-routed connection (see
  // app.module.ts's `replication` config) — GET /admin/disputes is
  // routinely called right after a webhook just wrote a new dispute (an
  // operator opening the list after being notified, or — as
  // test/webhooks.e2e-spec.ts does — a test listing immediately after
  // processing charge.dispute.created), which can lose the race against
  // the replica's ~1s streaming lag and simply not show the dispute yet —
  // see docs/technical/ci-cd.md.
  async findMany(filter?: FindDisputesFilter): Promise<Dispute[]> {
    const queryRunner = this.dataSource.createQueryRunner('master');
    let entities: DisputeEntity[];
    try {
      const qb = queryRunner.manager.createQueryBuilder(DisputeEntity, 'd');
      if (filter?.merchantId) {
        qb.andWhere('d.merchantId = :merchantId', { merchantId: filter.merchantId });
      }
      if (filter?.status) {
        qb.andWhere('d.status = :status', { status: filter.status });
      }
      qb.orderBy('d.createdAt', 'DESC').take(filter?.limit ?? 50);
      entities = await qb.getMany();
    } finally {
      await queryRunner.release();
    }
    return entities.map((e) => this.toDomain(e));
  }

  async countByMerchantSince(merchantId: string, status: DisputeStatus, since: Date): Promise<number> {
    // .toISOString(), not a raw Date bound via MoreThanOrEqual() — `disputes.created_at`
    // is a naive TIMESTAMP (no tz) column; node-postgres serializes a raw
    // Date parameter using this process's local timezone offset for such a
    // column, silently shifting the comparison. See
    // docs/technical/reconciliation.md's writeup of the same bug class
    // found in this exact codebase, and payment-typeorm.repository.ts's
    // findByMerchantId()/count() for the same fix applied there.
    return this.repo
      .createQueryBuilder('d')
      .where('d.merchantId = :merchantId', { merchantId })
      .andWhere('d.status = :status', { status })
      .andWhere('d.createdAt >= :since', { since: since.toISOString() })
      .getCount();
  }

  private toDomain(entity: DisputeEntity): Dispute {
    return Dispute.reconstitute({
      id: entity.id,
      paymentId: entity.paymentId,
      merchantId: entity.merchantId,
      pspProvider: entity.pspProvider,
      pspDisputeId: entity.pspDisputeId,
      amount: Money.fromMinorUnits(BigInt(entity.amountMinorUnits), entity.currencyCode),
      reason: entity.reason,
      status: entity.status,
      respondBy: entity.respondBy,
      evidence: entity.evidence,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      autoDecision: entity.autoDecision,
    });
  }
}
