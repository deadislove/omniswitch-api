import { Plan } from '../../domain/aggregates/plan.aggregate';

export interface FindPlansFilter {
  merchantId?: string;
  isActive?: boolean;
  limit?: number;
}

export abstract class PlanPort {
  abstract save(plan: Plan): Promise<void>;
  abstract findById(id: string): Promise<Plan | null>;

  /**
   * Same as findById(), but forced onto the master connection.
   * PlanService uses this exclusively for every single-plan lookup (not
   * just findById()) — a merchant creating a plan and immediately
   * viewing, subscribing to, or deactivating it is an ordinary sequence,
   * and the catalog's read volume is low enough that unconditionally
   * forcing master, rather than PaymentRepositoryPort's more surgical
   * per-call-site split, is the right tradeoff. See
   * PaymentRepositoryPort.findByIdOnMaster()'s docblock for the general
   * reasoning.
   */
  abstract findByIdOnMaster(id: string): Promise<Plan | null>;

  abstract findMany(filter?: FindPlansFilter): Promise<Plan[]>;

  /** Same as findMany(), but forced onto master — see findByIdOnMaster()'s docblock. */
  abstract findManyOnMaster(filter?: FindPlansFilter): Promise<Plan[]>;
}
