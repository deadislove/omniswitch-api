import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { PaymentRepositoryPort, FindPaymentsFilter } from '../../../ports/outbound/payment-repository.port';
import { PaymentAggregate, PSPProvider } from '../../../domain/aggregates/payment.aggregate';
import { PaymentStatus } from '../../../domain/value-objects/payment-status.vo';
import { PaymentEntity } from '../entities/payment.entity';
import { PaymentMapper } from '../mappers/payment.mapper';
import { LedgerOutboxPort } from '../../../ports/outbound/ledger-outbox.port';
import { LedgerOutboxEvent, LedgerEntry, OutboxStatus } from '../../../domain/aggregates/ledger-outbox.aggregate';
import { LedgerOutboxEntity } from '../entities/ledger-outbox.entity';
import { Money } from '../../../domain/value-objects/money.vo';

/**
 * TypeORM implementation of PaymentRepositoryPort
 * Supports Master/Replica routing via DataSource configuration.
 */
@Injectable()
export class PaymentTypeOrmRepository implements PaymentRepositoryPort {
  private readonly logger = new Logger(PaymentTypeOrmRepository.name);

  constructor(
    @InjectRepository(PaymentEntity)
    private readonly paymentRepo: Repository<PaymentEntity>,
    private readonly dataSource: DataSource,
  ) {}

  async save(payment: PaymentAggregate): Promise<void> {
    const entity = PaymentMapper.toPersistence(payment);
    await this.paymentRepo.save(entity);
    this.logger.debug(`Saved payment ${payment.id}`);
  }

  async findById(id: string): Promise<PaymentAggregate | null> {
    const entity = await this.paymentRepo.findOne({ where: { id } });
    if (!entity) return null;
    return PaymentMapper.toDomain(entity);
  }

  // See PaymentRepositoryPort.findByIdOnMaster()'s docblock for which
  // call sites use this instead of findById() and why.
  async findByIdOnMaster(id: string): Promise<PaymentAggregate | null> {
    const queryRunner = this.dataSource.createQueryRunner('master');
    let entity: PaymentEntity | null;
    try {
      entity = await queryRunner.manager.findOne(PaymentEntity, { where: { id } });
    } finally {
      await queryRunner.release();
    }
    if (!entity) return null;
    return PaymentMapper.toDomain(entity);
  }

  async findByIdempotencyKey(key: string): Promise<PaymentAggregate | null> {
    const entity = await this.paymentRepo.findOne({
      where: { idempotencyKey: key },
    });
    if (!entity) return null;
    return PaymentMapper.toDomain(entity);
  }

  async findByPspTransactionId(pspTransactionId: string): Promise<PaymentAggregate | null> {
    const entity = await this.paymentRepo.findOne({
      where: { pspTransactionId },
    });
    if (!entity) return null;
    return PaymentMapper.toDomain(entity);
  }

  async findByMerchantId(
    merchantId: string,
    filter?: FindPaymentsFilter,
  ): Promise<PaymentAggregate[]> {
    const qb = this.paymentRepo
      .createQueryBuilder('p')
      .where('p.merchantId = :merchantId', { merchantId });

    if (filter?.status) {
      qb.andWhere('p.status = :status', { status: filter.status });
    }
    if (filter?.fromDate) {
      // .toISOString(), not the raw Date object — see findByProviderAndDateRange's
      // comment below for why: `created_at` is `timestamp without time zone`,
      // and node-postgres serializes a bound Date parameter using this
      // process's local timezone offset for an untyped/naive-timestamp
      // column, silently shifting the comparison by that offset on any
      // non-UTC machine.
      qb.andWhere('p.createdAt >= :fromDate', { fromDate: filter.fromDate.toISOString() });
    }
    if (filter?.toDate) {
      qb.andWhere('p.createdAt <= :toDate', { toDate: filter.toDate.toISOString() });
    }

    qb.orderBy('p.createdAt', 'DESC')
      .take(filter?.limit ?? 50)
      .skip(filter?.offset ?? 0);

    const entities = await qb.getMany();
    return entities.map(PaymentMapper.toDomain);
  }

  async update(payment: PaymentAggregate): Promise<void> {
    const entity = PaymentMapper.toPersistence(payment);
    await this.paymentRepo.save(entity);
    this.logger.debug(`Updated payment ${payment.id} -> ${payment.status}`);
  }

  async existsById(id: string): Promise<boolean> {
    const count = await this.paymentRepo.count({ where: { id } });
    return count > 0;
  }

  async count(filter?: FindPaymentsFilter): Promise<number> {
    // fromDate/toDate used to be silently dropped here — FindPaymentsFilter
    // advertises them, findByMerchantId() above already honors them, but
    // this method's query builder never added the corresponding
    // andWhere() calls. Nothing called count() with a date range before
    // RiskTieringService, so it never produced a visibly wrong result in
    // practice — but it would have the moment anything did, silently
    // counting a merchant's *entire* history instead of the requested
    // window. Same .toISOString() handling as findByMerchantId() — see
    // that method's comment for why the naive-TIMESTAMP column needs it.
    const qb = this.paymentRepo.createQueryBuilder('p');
    if (filter?.merchantId) {
      qb.andWhere('p.merchantId = :merchantId', { merchantId: filter.merchantId });
    }
    if (filter?.status) {
      qb.andWhere('p.status = :status', { status: filter.status });
    }
    if (filter?.fromDate) {
      qb.andWhere('p.createdAt >= :fromDate', { fromDate: filter.fromDate.toISOString() });
    }
    if (filter?.toDate) {
      qb.andWhere('p.createdAt <= :toDate', { toDate: filter.toDate.toISOString() });
    }
    return qb.getCount();
  }

  async countByStatusAndProvider(): Promise<{ status: PaymentStatus; pspProvider: PSPProvider | null; count: number }[]> {
    const rows = await this.paymentRepo
      .createQueryBuilder('p')
      .select('p.status', 'status')
      .addSelect('p.pspProvider', 'pspProvider')
      .addSelect('COUNT(*)', 'count')
      .groupBy('p.status')
      .addGroupBy('p.pspProvider')
      .getRawMany();
    return rows.map((r) => ({
      status: r.status as PaymentStatus,
      pspProvider: (r.pspProvider ?? null) as PSPProvider | null,
      count: Number(r.count),
    }));
  }

  async findByProviderAndDateRange(
    pspProvider: PSPProvider,
    fromDate: Date,
    toDate: Date,
  ): Promise<PaymentAggregate[]> {
    // Any status where a real charge happened at the PSP — a later refund
    // or dispute doesn't change whether the *original* charge should still
    // match a PSP settlement transaction for the same amount.
    const chargedStatuses = ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED'];
    const entities = await this.paymentRepo
      .createQueryBuilder('p')
      .where('p.pspProvider = :pspProvider', { pspProvider })
      .andWhere('p.status IN (:...chargedStatuses)', { chargedStatuses })
      // .toISOString(), not the raw Date object. Found the hard way while
      // verifying reconciliation: `created_at` is `timestamp without time
      // zone` (TypeORM's @CreateDateColumn() default), and node-postgres
      // serializes a bound Date parameter for such a column using this
      // *process's local timezone offset*, not UTC. On a UTC+8 dev machine,
      // that silently shifted every comparison by 8 hours — a payment
      // charged seconds earlier wasn't found by a "last hour" window query.
      // An explicit ISO string (always UTC, unambiguous) sidesteps the
      // serialization entirely. Confirmed via a minimal reproduction
      // outside the app (same query, Date object vs. .toISOString()) before
      // concluding this wasn't a logic bug in the WHERE clause itself.
      .andWhere('p.createdAt >= :fromDate', { fromDate: fromDate.toISOString() })
      .andWhere('p.createdAt <= :toDate', { toDate: toDate.toISOString() })
      .getMany();
    return entities.map(PaymentMapper.toDomain);
  }

  async sumSucceededVolumeSince(merchantId: string, since: Date, currencyCode: string): Promise<bigint> {
    // .toISOString(), not the raw Date object — same createdAt-column
    // timezone gotcha findByProviderAndDateRange() above documents.
    const { total } = await this.paymentRepo
      .createQueryBuilder('p')
      .select('COALESCE(SUM(p.amountMinorUnits), 0)', 'total')
      .where('p.merchantId = :merchantId', { merchantId })
      .andWhere('p.currencyCode = :currencyCode', { currencyCode })
      .andWhere('p.status = :status', { status: 'SUCCEEDED' })
      .andWhere('p.createdAt >= :since', { since: since.toISOString() })
      .getRawOne();
    return BigInt(total ?? 0);
  }
}

/**
 * TypeORM implementation of LedgerOutboxPort
 * Supports atomic write of payment + outbox event in same transaction.
 */
@Injectable()
export class LedgerOutboxTypeOrmRepository implements LedgerOutboxPort {
  private readonly logger = new Logger(LedgerOutboxTypeOrmRepository.name);

  constructor(
    @InjectRepository(LedgerOutboxEntity)
    private readonly outboxRepo: Repository<LedgerOutboxEntity>,
    private readonly dataSource: DataSource,
  ) {}

  async saveWithPayment(
    paymentId: string,
    outboxEvent: LedgerOutboxEvent,
    transactionManager?: unknown,
  ): Promise<void> {
    const entity = new LedgerOutboxEntity();
    entity.id = outboxEvent.id;
    entity.paymentId = outboxEvent.paymentId;
    entity.eventType = outboxEvent.eventType;
    entity.entries = outboxEvent.entries.map((e) => ({
      accountId: e.accountId,
      accountType: e.accountType,
      entryType: e.entryType,
      amountMinorUnits: e.amount.amountMinorUnits.toString(),
      currencyCode: e.amount.currency.code,
      description: e.description,
    }));
    entity.status = outboxEvent.status;
    entity.retryCount = outboxEvent.retryCount;

    if (transactionManager) {
      const repo = (transactionManager as any).getRepository(LedgerOutboxEntity);
      await repo.save(entity);
    } else {
      await this.outboxRepo.save(entity);
    }
    this.logger.debug(`Saved ledger outbox event ${outboxEvent.id} for payment ${paymentId}`);
  }

  async findPending(limit = 100): Promise<LedgerOutboxEvent[]> {
    // Forced onto master, not the ambient replica-routed connection (see
    // app.module.ts's `replication` config) — this is a low-volume
    // internal poll (every 10s, batch of `limit`) whose whole job is to
    // notice new PENDING events as fast as possible. It has nothing to
    // gain from replica routing but is fully exposed to its ~1s lag: an
    // event a write just committed to master (e.g. the outbox admin retry
    // endpoint resetting a FAILED event back to PENDING) can be invisible
    // here for up to one lag window, silently delaying pickup by a full
    // relay tick. Confirmed live via test/ledger-and-outbox.e2e-spec.ts's
    // dead-letter recovery test, which calls this synchronously right
    // after that reset and expects it picked up in the same tick.
    const queryRunner = this.dataSource.createQueryRunner('master');
    let entities: LedgerOutboxEntity[];
    try {
      entities = await queryRunner.manager.find(LedgerOutboxEntity, {
        where: { status: 'PENDING' },
        order: { createdAt: 'ASC' },
        take: limit,
      });
    } finally {
      await queryRunner.release();
    }
    return entities.map(this.toDomain);
  }

  async markPublished(eventId: string): Promise<void> {
    await this.outboxRepo.update(eventId, {
      status: 'PUBLISHED',
      processedAt: new Date(),
    });
  }

  async markFailed(eventId: string, error: string): Promise<void> {
    const entity = await this.outboxRepo.findOne({ where: { id: eventId } });
    if (entity) {
      await this.outboxRepo.update(eventId, {
        status: 'FAILED',
        lastError: error,
        retryCount: entity.retryCount + 1,
      });
    }
  }

  async findStale(olderThanMinutes: number): Promise<LedgerOutboxEvent[]> {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);
    const entities = await this.outboxRepo
      .createQueryBuilder('o')
      .where('o.status = :status', { status: 'PENDING' })
      // .toISOString() — see findByProviderAndDateRange's comment in this
      // file for why a raw Date object silently breaks this comparison on
      // a non-UTC machine (found while building reconciliation). This
      // means `detectStaleEvents()`'s alerting was very likely a silent
      // no-op for anyone running this stack outside UTC — worth specifically
      // re-checking if it's ever been relied on before this fix.
      .andWhere('o.createdAt < :cutoff', { cutoff: cutoff.toISOString() })
      .getMany();
    return entities.map(this.toDomain);
  }

  async findById(eventId: string): Promise<LedgerOutboxEvent | null> {
    const entity = await this.outboxRepo.findOne({ where: { id: eventId } });
    return entity ? this.toDomain(entity) : null;
  }

  async findFailed(limit = 100): Promise<LedgerOutboxEvent[]> {
    const entities = await this.outboxRepo.find({
      where: { status: 'FAILED' },
      order: { createdAt: 'ASC' },
      take: limit,
    });
    return entities.map(this.toDomain);
  }

  async resetToPending(eventId: string): Promise<boolean> {
    const result = await this.outboxRepo
      .createQueryBuilder()
      .update(LedgerOutboxEntity)
      .set({ status: 'PENDING', lastError: () => 'NULL' })
      .where('id = :id', { id: eventId })
      .andWhere('status = :status', { status: 'FAILED' })
      .execute();
    return (result.affected ?? 0) > 0;
  }

  async countByStatus(status: OutboxStatus): Promise<number> {
    return this.outboxRepo.count({ where: { status } });
  }

  async findCreatedBetween(since: Date, until: Date): Promise<LedgerOutboxEvent[]> {
    // .toISOString() — same naive-TIMESTAMP-column reason as findStale()
    // above: a raw JS Date gets serialized using the host process's local
    // timezone by node-postgres, silently shifting the comparison.
    const entities = await this.outboxRepo
      .createQueryBuilder('o')
      .where('o.createdAt >= :since', { since: since.toISOString() })
      .andWhere('o.createdAt < :until', { until: until.toISOString() })
      .orderBy('o.createdAt', 'ASC')
      .getMany();
    return entities.map(this.toDomain);
  }

  private toDomain(entity: LedgerOutboxEntity): LedgerOutboxEvent {
    // Previously always reconstituted with entries: [] — every event
    // handed to the relay/publisher had its actual debit/credit lines
    // stripped out, so nothing consuming findPending()/findStale() could
    // ever see what was actually being settled.
    const entries: LedgerEntry[] = (entity.entries || []).map((raw: any) => ({
      accountId: raw.accountId,
      accountType: raw.accountType,
      entryType: raw.entryType,
      amount: Money.fromMinorUnits(BigInt(raw.amountMinorUnits), raw.currencyCode),
      description: raw.description,
    }));

    return LedgerOutboxEvent.reconstitute({
      id: entity.id,
      paymentId: entity.paymentId,
      eventType: entity.eventType,
      entries,
      status: entity.status,
      createdAt: entity.createdAt,
      processedAt: entity.processedAt,
      retryCount: entity.retryCount,
      lastError: entity.lastError,
    });
  }
}
