import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { randomUUID as uuidv4 } from 'crypto';
import { PlanPort, FindPlansFilter } from '../../ports/outbound/plan.port';
import { Plan } from '../../domain/aggregates/plan.aggregate';
import { Money } from '../../domain/value-objects/money.vo';
import { BillingInterval } from '../../domain/aggregates/subscription.aggregate';

/**
 * Plan Service
 * Owns the Plan catalog's lifecycle — see Plan aggregate's docblock for
 * why plans are immutable once created (deactivate() only) and why a
 * Subscription never holds a live reference to one.
 */
@Injectable()
export class PlanService {
  private readonly logger = new Logger(PlanService.name);

  constructor(private readonly planPort: PlanPort) {}

  async createPlan(params: {
    merchantId: string;
    name: string;
    amount: Money;
    interval: BillingInterval;
    intervalCount: number;
  }): Promise<Plan> {
    const plan = Plan.create({ id: uuidv4(), ...params });
    await this.planPort.save(plan);
    this.logger.log(`Plan ${plan.id} (${plan.name}) created for merchant ${params.merchantId}`);
    return plan;
  }

  /** Reads via findManyOnMaster() — see getOrThrow()'s docblock for why. */
  async findMany(filter?: FindPlansFilter): Promise<Plan[]> {
    return this.planPort.findManyOnMaster(filter);
  }

  /**
   * Reads via findByIdOnMaster(), not the ambient replica-routed
   * findById() — a merchant creating a plan and immediately viewing,
   * subscribing to, or deactivating it is an ordinary sequence, and this
   * catalog's read volume is low enough that every lookup here can
   * afford to skip the replica.
   */
  async getOrThrow(id: string): Promise<Plan> {
    const plan = await this.planPort.findByIdOnMaster(id);
    if (!plan) {
      throw new NotFoundException({ statusCode: 404, error: `Plan ${id} not found`, code: 'PLAN_NOT_FOUND' });
    }
    return plan;
  }

  /** Used by SubscriptionService before subscribing/changing to a plan — a merchant can't subscribe a customer to another merchant's plan, deactivated or not. */
  async getUsablePlanOrThrow(id: string, merchantId: string): Promise<Plan> {
    const plan = await this.getOrThrow(id);
    if (plan.merchantId !== merchantId) {
      throw new ForbiddenException({ statusCode: 403, error: 'Forbidden', code: 'ACCESS_DENIED' });
    }
    if (!plan.isActive) {
      throw new NotFoundException({ statusCode: 404, error: `Plan ${id} is deactivated`, code: 'PLAN_DEACTIVATED' });
    }
    return plan;
  }

  /** No merchant check here — the caller (PlanController) already did the role-aware ownership check via getOrThrow()+assertOwnership(), same two-step pattern SubscriptionController.cancel() uses. A blanket check here would incorrectly block an ADMIN acting on another merchant's plan. */
  async deactivate(id: string): Promise<Plan> {
    const plan = await this.getOrThrow(id);
    plan.deactivate();
    await this.planPort.save(plan);
    this.logger.log(`Plan ${id} deactivated`);
    return plan;
  }
}
