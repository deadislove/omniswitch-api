import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { WebhookDeliveryLogEntity } from './webhook-delivery-log.entity';

export interface RecordWebhookDeliveryParams {
  merchantId: string;
  eventType: string;
  targetUrl: string;
  payload: Record<string, unknown>;
  success: boolean;
  statusCode?: number;
  errorMessage?: string;
  latencyMs: number;
  replayOfDeliveryId?: string;
}

/**
 * Webhook Delivery Log Service
 * Lives in `shared/`, not `payment/` or `merchant/`, because both
 * modules' `Webhook*NotificationAdapter` classes need to call
 * `record()` — dispute/subscription/AML-review adapters live in
 * `PaymentModule`, the sanctions adapter in `MerchantModule` — and
 * `MerchantModule` must never depend on `PaymentModule` (see
 * `docs/technical/architecture.md`'s module graph). Same reasoning
 * `notification-delivery.util.ts` itself already moved here for.
 *
 * Deliberately a plain persistence service, not a port/adapter pair —
 * unlike `KYCProviderPort`/`SanctionsScreeningPort`, there's no real
 * "mock vs. real" swap here: recording a delivery to this app's own
 * database has exactly one real implementation regardless of
 * environment.
 */
@Injectable()
export class WebhookDeliveryLogService {
  constructor(
    @InjectRepository(WebhookDeliveryLogEntity)
    private readonly repo: Repository<WebhookDeliveryLogEntity>,
  ) {}

  /**
   * Never throws — a logging failure must never mask (or, worse, abort)
   * the actual delivery attempt it's recording. Called from inside each
   * `Webhook*NotificationAdapter.send()`, itself already wrapped by
   * `*NotificationDispatcherService`'s own best-effort try/catch; a
   * second failure mode stacked on top of that would just be noise the
   * caller can't act on differently. Returns the saved row (so
   * `WebhookDeliveryReplayService` can hand it straight back to its own
   * caller without a redundant re-query) — `null` only on the logging
   * failure this method itself swallows.
   */
  async record(params: RecordWebhookDeliveryParams): Promise<WebhookDeliveryLogEntity | null> {
    try {
      const entity = this.repo.create({
        id: randomUUID(),
        merchantId: params.merchantId,
        eventType: params.eventType,
        targetUrl: params.targetUrl,
        payload: params.payload,
        success: params.success,
        statusCode: params.statusCode ?? null,
        errorMessage: params.errorMessage ?? null,
        latencyMs: params.latencyMs,
        replayOfDeliveryId: params.replayOfDeliveryId ?? null,
      });
      return await this.repo.save(entity);
    } catch {
      // Best-effort — see this method's own docblock.
      return null;
    }
  }

  /**
   * Keyset-paginated (see `RiskTieringService.findActiveAutoManagedBatch()`'s
   * own docblock for why offset pagination doesn't scale here either),
   * newest first — an operator inspecting delivery history cares about
   * recent activity, not the oldest row first.
   */
  async findByMerchant(
    merchantId: string,
    filters: { eventType?: string; success?: boolean } = {},
    afterId: string | undefined,
    limit: number,
  ): Promise<WebhookDeliveryLogEntity[]> {
    const qb = this.repo
      .createQueryBuilder('d')
      .where('d.merchantId = :merchantId', { merchantId })
      .orderBy('d.createdAt', 'DESC')
      .addOrderBy('d.id', 'DESC')
      .take(limit);

    if (filters.eventType) qb.andWhere('d.eventType = :eventType', { eventType: filters.eventType });
    if (filters.success !== undefined) qb.andWhere('d.success = :success', { success: filters.success });
    if (afterId) {
      const cursor = await this.repo.findOne({ where: { id: afterId } });
      if (cursor) {
        qb.andWhere('(d.createdAt, d.id) < (:cursorCreatedAt, :afterId)', {
          cursorCreatedAt: cursor.createdAt,
          afterId,
        });
      }
    }

    return qb.getMany();
  }

  async findById(id: string): Promise<WebhookDeliveryLogEntity | null> {
    return this.repo.findOne({ where: { id } });
  }
}
