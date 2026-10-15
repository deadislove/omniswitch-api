import { BnplOrder } from '../../domain/aggregates/bnpl-order.aggregate';

/**
 * BNPL Order Port (Outbound)
 * Persistence contract for `BnplOrder` — same single-aggregate-per-port
 * shape as `PayoutPort`, rather than folding this into
 * `PaymentRepositoryPort` the way a card charge's lifecycle lives in
 * one place, since a `BnplOrder` is never a `PaymentAggregate`.
 */
export abstract class BnplOrderPort {
  abstract save(order: BnplOrder): Promise<void>;
  abstract findById(id: string): Promise<BnplOrder | null>;
  abstract findByIdempotencyKey(idempotencyKey: string): Promise<BnplOrder | null>;
}
