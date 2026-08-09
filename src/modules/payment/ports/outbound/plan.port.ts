import { Plan } from '../../domain/aggregates/plan.aggregate';

export interface FindPlansFilter {
  merchantId?: string;
  isActive?: boolean;
  limit?: number;
}

export abstract class PlanPort {
  abstract save(plan: Plan): Promise<void>;
  abstract findById(id: string): Promise<Plan | null>;
  abstract findMany(filter?: FindPlansFilter): Promise<Plan[]>;
}
