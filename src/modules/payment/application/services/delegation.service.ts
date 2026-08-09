import { Injectable, Logger, NotFoundException, ConflictException, ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { DelegationPort, FindDelegationsFilter } from '../../ports/outbound/delegation.port';
import { Delegation } from '../../domain/aggregates/delegation.aggregate';
import { SpendPolicy } from '../../domain/value-objects/spend-policy.vo';
import { Money } from '../../domain/value-objects/money.vo';
import { JwtPayload } from '../../../../shared/auth/jwt.strategy';
import { TokenRevocationService } from '../../../../shared/auth/token-revocation.service';
import { UserRole } from '../../../../shared/decorators/roles.decorator';

const DEFAULT_AGENT_TOKEN_TTL_SECONDS = 24 * 3600;

export interface CreateDelegationParams {
  merchantId: string;
  agentName: string;
  perTransactionLimit: Money;
  monthlyLimit: Money;
  allowedCategories?: string[];
  tokenTtlSeconds?: number;
}

/**
 * Delegation Service
 * Issues, revokes, and enforces spend limits against Delegation credentials
 * — the "narrow, revocable, auditable slice of purchasing power" a
 * merchant grants an autonomous agent, distinct from the merchant's own
 * full-access JWT. See delegation.aggregate.ts's docblock for the domain
 * framing.
 */
@Injectable()
export class DelegationService {
  private readonly logger = new Logger(DelegationService.name);

  constructor(
    private readonly delegationPort: DelegationPort,
    private readonly jwtService: JwtService,
    private readonly tokenRevocation: TokenRevocationService,
  ) {}

  /** Creates the Delegation and, in the same call, issues its one agent JWT — there's no separate "issue credential" step, the same way creating a merchant's initial API key isn't a separate step from onboarding. */
  async createDelegation(params: CreateDelegationParams): Promise<{ delegation: Delegation; agentToken: string; expiresIn: number }> {
    const spendPolicy = SpendPolicy.create({
      perTransactionLimit: params.perTransactionLimit,
      monthlyLimit: params.monthlyLimit,
      allowedCategories: params.allowedCategories,
    });

    const id = uuidv4();
    const jti = randomUUID();
    const expiresIn = params.tokenTtlSeconds ?? DEFAULT_AGENT_TOKEN_TTL_SECONDS;
    const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000);

    const delegation = Delegation.create({
      id,
      merchantId: params.merchantId,
      agentName: params.agentName,
      spendPolicy,
      jti,
      tokenExpiresAt,
    });
    await this.delegationPort.save(delegation);

    const payload: JwtPayload = {
      sub: id,
      merchantId: params.merchantId,
      roles: [UserRole.AGENT],
      jti,
      delegationId: id,
    };
    const agentToken = this.jwtService.sign(payload, { expiresIn });

    this.logger.log(`Delegation ${id} created for merchant ${params.merchantId} (agent "${params.agentName}")`);
    return { delegation, agentToken, expiresIn };
  }

  async getOrThrow(id: string): Promise<Delegation> {
    const delegation = await this.delegationPort.findById(id);
    if (!delegation) {
      throw new NotFoundException({ statusCode: 404, error: `Delegation ${id} not found`, code: 'DELEGATION_NOT_FOUND' });
    }
    return delegation;
  }

  findMany(filter?: FindDelegationsFilter): Promise<Delegation[]> {
    return this.delegationPort.findMany(filter);
  }

  /** Revoking takes effect immediately, not just on the token's natural expiry — reuses the exact same jti-revocation mechanism POST /auth/revoke (logout) does, rather than inventing a second one for delegation tokens specifically. */
  async revoke(id: string): Promise<Delegation> {
    const delegation = await this.getOrThrow(id);
    if (delegation.status === 'REVOKED') {
      throw new ConflictException({ statusCode: 409, error: `Delegation ${id} is already revoked`, code: 'DELEGATION_ALREADY_REVOKED' });
    }
    const now = new Date();
    delegation.revoke(now);
    await this.delegationPort.save(delegation);

    const remainingSeconds = Math.floor((delegation.tokenExpiresAt.getTime() - now.getTime()) / 1000);
    await this.tokenRevocation.revokeToken(delegation.jti, remainingSeconds);

    this.logger.log(`Delegation ${id} revoked — its agent token is now rejected on the next request`);
    return delegation;
  }

  /**
   * Called by PaymentController.charge() before the checkout saga runs, for
   * an AGENT-authenticated request only. Pre-checks each condition against
   * the currently-loaded Delegation for a precise error, then performs the
   * actual race-safe reservation via DelegationPort.tryReserveSpend() — see
   * that port method's docblock for why both layers exist. Throws (nothing
   * reserved) on any violation; the caller must call releaseReservation()
   * if the charge it went on to attempt subsequently fails.
   */
  async reserveSpendOrThrow(delegationId: string, amount: Money, category: string | undefined, now: Date): Promise<void> {
    const delegation = await this.getOrThrow(delegationId);

    if (delegation.status !== 'ACTIVE') {
      throw new ForbiddenException({ statusCode: 403, error: `Delegation ${delegationId} has been revoked`, code: 'DELEGATION_REVOKED' });
    }
    if (amount.currency.code !== delegation.spendPolicy.currency) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: `Charge currency ${amount.currency.code} does not match this delegation's spend-policy currency ${delegation.spendPolicy.currency}`,
        code: 'DELEGATION_CURRENCY_MISMATCH',
      });
    }
    if (amount.isGreaterThan(delegation.spendPolicy.perTransactionLimit)) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: `Charge of ${amount.toString()} exceeds this delegation's per-transaction limit of ${delegation.spendPolicy.perTransactionLimit.toString()}`,
        code: 'DELEGATION_PER_TRANSACTION_LIMIT_EXCEEDED',
      });
    }
    if (!delegation.spendPolicy.isCategoryAllowed(category)) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: `Category '${category ?? '(none)'}' is not allowed by this delegation's spend policy`,
        code: 'DELEGATION_CATEGORY_NOT_ALLOWED',
      });
    }
    const spentSoFar = delegation.spentThisMonth(now);
    if (spentSoFar.add(amount).isGreaterThan(delegation.spendPolicy.monthlyLimit)) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: `Charge of ${amount.toString()} would exceed this delegation's remaining monthly budget (${spentSoFar.toString()} already spent of ${delegation.spendPolicy.monthlyLimit.toString()} this month)`,
        code: 'DELEGATION_MONTHLY_LIMIT_EXCEEDED',
      });
    }

    const reserved = await this.delegationPort.tryReserveSpend(delegationId, amount, now);
    if (!reserved) {
      // Lost a race with a concurrent charge against the same delegation —
      // the checks above passed against a now-stale read.
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: `Charge of ${amount.toString()} would exceed this delegation's spend policy (lost a race with a concurrent charge)`,
        code: 'DELEGATION_SPEND_LIMIT_EXCEEDED',
      });
    }
  }

  /** Compensating release — see DelegationPort.releaseSpend()'s docblock. */
  async releaseReservation(delegationId: string, amount: Money): Promise<void> {
    await this.delegationPort.releaseSpend(delegationId, amount);
  }
}
