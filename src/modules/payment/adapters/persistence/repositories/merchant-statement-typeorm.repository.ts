import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MerchantStatementPort, FindStatementsFilter } from '../../../ports/outbound/merchant-statement.port';
import { MerchantStatement, StatementCurrencyBreakdown } from '../../../domain/aggregates/merchant-statement.aggregate';
import { Money } from '../../../domain/value-objects/money.vo';
import { MerchantStatementEntity } from '../entities/merchant-statement.entity';

@Injectable()
export class MerchantStatementTypeOrmRepository implements MerchantStatementPort {
  constructor(
    @InjectRepository(MerchantStatementEntity)
    private readonly repo: Repository<MerchantStatementEntity>,
  ) {}

  async save(statement: MerchantStatement): Promise<void> {
    const entity = new MerchantStatementEntity();
    entity.id = statement.id;
    entity.merchantId = statement.merchantId;
    entity.periodStart = statement.periodStart;
    entity.periodEnd = statement.periodEnd;
    entity.generatedAt = statement.generatedAt;
    entity.breakdowns = statement.breakdowns.map((b) => ({
      currencyCode: b.currencyCode,
      chargeCount: b.chargeCount,
      grossVolumeMinorUnits: b.grossVolume.amountMinorUnits.toString(),
      platformFeeMinorUnits: b.platformFee.amountMinorUnits.toString(),
      providerFeeMinorUnits: b.providerFee.amountMinorUnits.toString(),
      refundedAmountMinorUnits: b.refundedAmount.amountMinorUnits.toString(),
      chargebackCount: b.chargebackCount,
      chargebackAmountMinorUnits: b.chargebackAmount.amountMinorUnits.toString(),
      marketplaceSplitProceedsMinorUnits: b.marketplaceSplitProceedsMinorUnits.toString(),
      netSettlementMinorUnits: b.netSettlementMinorUnits.toString(),
    }));
    await this.repo.save(entity);
  }

  async findById(id: string): Promise<MerchantStatement | null> {
    const entity = await this.repo.findOne({ where: { id } });
    return entity ? this.toDomain(entity) : null;
  }

  async findByMerchantAndPeriod(merchantId: string, periodStart: Date, periodEnd: Date): Promise<MerchantStatement | null> {
    // Raw Date params are safe here (unlike dispute-typeorm.repository.ts's
    // countByMerchantSince()) — period_start/period_end are `timestamptz`
    // columns; the naive-TIMESTAMP timezone-shift bug that forces
    // .toISOString() elsewhere only applies to columns without a timezone.
    const entity = await this.repo.findOne({
      where: { merchantId, periodStart, periodEnd },
    });
    return entity ? this.toDomain(entity) : null;
  }

  async findByMerchantId(merchantId: string, filter?: FindStatementsFilter): Promise<MerchantStatement[]> {
    const entities = await this.repo.find({
      where: { merchantId },
      order: { periodStart: 'DESC' },
      take: filter?.limit ?? 50,
      skip: filter?.offset ?? 0,
    });
    return entities.map((e) => this.toDomain(e));
  }

  private toDomain(entity: MerchantStatementEntity): MerchantStatement {
    const breakdowns: StatementCurrencyBreakdown[] = (entity.breakdowns ?? []).map((raw: any) => ({
      currencyCode: raw.currencyCode,
      chargeCount: raw.chargeCount,
      grossVolume: Money.fromMinorUnits(BigInt(raw.grossVolumeMinorUnits), raw.currencyCode),
      platformFee: Money.fromMinorUnits(BigInt(raw.platformFeeMinorUnits), raw.currencyCode),
      providerFee: Money.fromMinorUnits(BigInt(raw.providerFeeMinorUnits), raw.currencyCode),
      refundedAmount: Money.fromMinorUnits(BigInt(raw.refundedAmountMinorUnits), raw.currencyCode),
      chargebackCount: raw.chargebackCount,
      chargebackAmount: Money.fromMinorUnits(BigInt(raw.chargebackAmountMinorUnits), raw.currencyCode),
      marketplaceSplitProceedsMinorUnits: BigInt(raw.marketplaceSplitProceedsMinorUnits),
      netSettlementMinorUnits: BigInt(raw.netSettlementMinorUnits),
    }));

    return MerchantStatement.reconstitute({
      id: entity.id,
      merchantId: entity.merchantId,
      periodStart: entity.periodStart,
      periodEnd: entity.periodEnd,
      breakdowns,
      generatedAt: entity.generatedAt,
    });
  }
}
