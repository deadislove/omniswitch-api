import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ReconciliationPort } from '../../../ports/outbound/reconciliation.port';
import { ReconciliationRun, ReconciliationMismatch } from '../../../domain/aggregates/reconciliation-run.aggregate';
import { PSPProvider } from '../../../domain/aggregates/payment.aggregate';
import { ReconciliationRunEntity } from '../entities/reconciliation-run.entity';
import { Money } from '../../../domain/value-objects/money.vo';

@Injectable()
export class ReconciliationTypeOrmRepository implements ReconciliationPort {
  constructor(
    @InjectRepository(ReconciliationRunEntity)
    private readonly repo: Repository<ReconciliationRunEntity>,
  ) {}

  async save(run: ReconciliationRun): Promise<void> {
    const entity = new ReconciliationRunEntity();
    entity.id = run.id;
    entity.pspProvider = run.pspProvider;
    entity.windowStart = run.windowStart;
    entity.windowEnd = run.windowEnd;
    entity.transactionsChecked = run.transactionsChecked;
    entity.status = run.status;
    entity.ranAt = run.ranAt;
    entity.mismatches = run.mismatches.map((m) => ({
      type: m.type,
      paymentId: m.paymentId,
      pspTransactionId: m.pspTransactionId,
      expectedAmount: m.expectedAmount
        ? { amountMinorUnits: m.expectedAmount.amountMinorUnits.toString(), currencyCode: m.expectedAmount.currency.code }
        : undefined,
      actualAmount: m.actualAmount
        ? { amountMinorUnits: m.actualAmount.amountMinorUnits.toString(), currencyCode: m.actualAmount.currency.code }
        : undefined,
      description: m.description,
    }));
    await this.repo.save(entity);
  }

  async findRecent(limit = 50): Promise<ReconciliationRun[]> {
    const entities = await this.repo.find({ order: { ranAt: 'DESC' }, take: limit });
    return entities.map(this.toDomain);
  }

  async findByProvider(pspProvider: PSPProvider, limit = 50): Promise<ReconciliationRun[]> {
    const entities = await this.repo.find({
      where: { pspProvider },
      order: { ranAt: 'DESC' },
      take: limit,
    });
    return entities.map(this.toDomain);
  }

  private toDomain(entity: ReconciliationRunEntity): ReconciliationRun {
    const mismatches: ReconciliationMismatch[] = (entity.mismatches || []).map((raw: any) => ({
      type: raw.type,
      paymentId: raw.paymentId,
      pspTransactionId: raw.pspTransactionId,
      expectedAmount: raw.expectedAmount
        ? Money.fromMinorUnits(BigInt(raw.expectedAmount.amountMinorUnits), raw.expectedAmount.currencyCode)
        : undefined,
      actualAmount: raw.actualAmount
        ? Money.fromMinorUnits(BigInt(raw.actualAmount.amountMinorUnits), raw.actualAmount.currencyCode)
        : undefined,
      description: raw.description,
    }));

    return ReconciliationRun.reconstitute({
      id: entity.id,
      pspProvider: entity.pspProvider as PSPProvider,
      windowStart: entity.windowStart,
      windowEnd: entity.windowEnd,
      transactionsChecked: entity.transactionsChecked,
      mismatches,
      status: entity.status,
      ranAt: entity.ranAt,
    });
  }
}
