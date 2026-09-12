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
   * Same as findById(), but forced onto the master connection — for a
   * caller that may have just written this exact Plan and can't tolerate
   * replica lag. See PaymentRepositoryPort.findByIdOnMaster()'s docblock
   * for the general reasoning; PlanService.getUsablePlanOrThrow() is the
   * one caller here (a merchant creating a plan and immediately
   * subscribing/changing to it is an ordinary sequence, not just a test
   * artifact).
   */
  abstract findByIdOnMaster(id: string): Promise<Plan | null>;

  abstract findMany(filter?: FindPlansFilter): Promise<Plan[]>;
}
