import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WebhookDeliveryLogEntity } from './webhook-delivery-log.entity';
import { WebhookDeliveryLogService } from './webhook-delivery-log.service';

/**
 * Imported by both `PaymentModule` (dispute/subscription/AML-review
 * webhook adapters) and `MerchantModule` (the sanctions-screening
 * webhook adapter) — see `WebhookDeliveryLogService`'s own docblock for
 * why this lives in `shared/` rather than either of those two modules.
 */
@Module({
  imports: [TypeOrmModule.forFeature([WebhookDeliveryLogEntity])],
  providers: [WebhookDeliveryLogService],
  exports: [WebhookDeliveryLogService],
})
export class WebhookDeliveryLogModule {}
