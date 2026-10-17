import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MerchantTaxFormPort, FindTaxFormsFilter } from '../../../ports/outbound/merchant-tax-form.port';
import { MerchantTaxForm1099K } from '../../../domain/aggregates/merchant-tax-form-1099k.aggregate';
import { Money } from '../../../domain/value-objects/money.vo';
import { MerchantTaxForm1099KEntity } from '../entities/merchant-tax-form-1099k.entity';

@Injectable()
export class MerchantTaxForm1099KTypeOrmRepository implements MerchantTaxFormPort {
  constructor(
    @InjectRepository(MerchantTaxForm1099KEntity)
    private readonly repo: Repository<MerchantTaxForm1099KEntity>,
  ) {}

  async save(form: MerchantTaxForm1099K): Promise<void> {
    const entity = new MerchantTaxForm1099KEntity();
    entity.id = form.id;
    entity.merchantId = form.merchantId;
    entity.taxYear = form.taxYear;
    entity.currencyCode = form.currencyCode;
    entity.grossAmountMinorUnits = form.grossAmount.amountMinorUnits.toString();
    entity.transactionCount = form.transactionCount;
    entity.monthlyAmountsMinorUnits = form.monthlyAmounts.map((m) => m.amountMinorUnits.toString());
    entity.thresholdAppliedMinorUnits = form.thresholdApplied.amountMinorUnits.toString();
    entity.reportable = form.reportable;
    entity.generatedAt = form.generatedAt;
    await this.repo.save(entity);
  }

  async findById(id: string): Promise<MerchantTaxForm1099K | null> {
    const entity = await this.repo.findOne({ where: { id } });
    return entity ? this.toDomain(entity) : null;
  }

  async findByMerchantAndYear(merchantId: string, taxYear: number): Promise<MerchantTaxForm1099K | null> {
    const entity = await this.repo.findOne({ where: { merchantId, taxYear } });
    return entity ? this.toDomain(entity) : null;
  }

  async findByMerchantId(merchantId: string, filter?: FindTaxFormsFilter): Promise<MerchantTaxForm1099K[]> {
    const entities = await this.repo.find({
      where: { merchantId },
      order: { taxYear: 'DESC' },
      take: filter?.limit ?? 50,
      skip: filter?.offset ?? 0,
    });
    return entities.map((e) => this.toDomain(e));
  }

  private toDomain(entity: MerchantTaxForm1099KEntity): MerchantTaxForm1099K {
    return MerchantTaxForm1099K.reconstitute({
      id: entity.id,
      merchantId: entity.merchantId,
      taxYear: entity.taxYear,
      currencyCode: entity.currencyCode,
      grossAmount: Money.fromMinorUnits(BigInt(entity.grossAmountMinorUnits), entity.currencyCode),
      transactionCount: entity.transactionCount,
      monthlyAmounts: entity.monthlyAmountsMinorUnits.map((m) => Money.fromMinorUnits(BigInt(m), entity.currencyCode)),
      thresholdApplied: Money.fromMinorUnits(BigInt(entity.thresholdAppliedMinorUnits), entity.currencyCode),
      reportable: entity.reportable,
      generatedAt: entity.generatedAt,
    });
  }
}
