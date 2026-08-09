import { Money } from '../value-objects/money.vo';
import { PSPProvider } from './payment.aggregate';
import { DisputeAutoDecision } from '../services/dispute-policy';

export type DisputeStatus = 'NEEDS_RESPONSE' | 'UNDER_REVIEW' | 'WON' | 'LOST';

// Stripe/Adyen both typically give merchants about a week to respond to a
// dispute before it's auto-decided against them — used here as a
// reasonable, documented default rather than a value either PSP's mock
// webhook actually supplies.
const DEFAULT_RESPONSE_WINDOW_DAYS = 7;

/**
 * Dispute Aggregate
 * A chargeback/dispute reported by a PSP against an already-`SUCCEEDED`
 * payment (see PaymentAggregate.markDisputed()). Tracked as its own record,
 * not just a payment status flip, because a dispute has a lifecycle of its
 * own — evidence submission, a response deadline, an eventual won/lost
 * outcome — that the payment's own state machine has no room to represent.
 */
export class Dispute {
  private constructor(
    private readonly _id: string,
    private readonly _paymentId: string,
    private readonly _merchantId: string,
    private readonly _pspProvider: PSPProvider,
    private readonly _pspDisputeId: string,
    private readonly _amount: Money,
    private readonly _reason: string | undefined,
    private _status: DisputeStatus,
    private readonly _respondBy: Date,
    private _evidence: string | undefined,
    private readonly _createdAt: Date,
    private _updatedAt: Date,
    private readonly _autoDecision: DisputeAutoDecision | undefined,
  ) {}

  static create(params: {
    id: string;
    paymentId: string;
    merchantId: string;
    pspProvider: PSPProvider;
    pspDisputeId: string;
    amount: Money;
    reason?: string;
    /** Set once, at creation, by DisputeService.recordDispute() — see dispute-policy.ts. Immutable: an operator's later manual action doesn't retroactively change what the policy originally recommended. */
    autoDecision?: DisputeAutoDecision;
  }): Dispute {
    const now = new Date();
    const respondBy = new Date(now.getTime() + DEFAULT_RESPONSE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    return new Dispute(
      params.id,
      params.paymentId,
      params.merchantId,
      params.pspProvider,
      params.pspDisputeId,
      params.amount,
      params.reason,
      'NEEDS_RESPONSE',
      respondBy,
      undefined,
      now,
      now,
      params.autoDecision,
    );
  }

  static reconstitute(params: {
    id: string;
    paymentId: string;
    merchantId: string;
    pspProvider: PSPProvider;
    pspDisputeId: string;
    amount: Money;
    reason?: string;
    status: DisputeStatus;
    respondBy: Date;
    evidence?: string;
    createdAt: Date;
    updatedAt: Date;
    autoDecision?: DisputeAutoDecision;
  }): Dispute {
    return new Dispute(
      params.id,
      params.paymentId,
      params.merchantId,
      params.pspProvider,
      params.pspDisputeId,
      params.amount,
      params.reason,
      params.status,
      params.respondBy,
      params.evidence,
      params.createdAt,
      params.updatedAt,
      params.autoDecision,
    );
  }

  /** Representment — submitting evidence to contest the dispute at the PSP. */
  submitEvidence(evidence: string): void {
    if (this._status !== 'NEEDS_RESPONSE') {
      throw new Error(`Cannot submit evidence for dispute in status: ${this._status}`);
    }
    this._evidence = evidence;
    this._status = 'UNDER_REVIEW';
    this._updatedAt = new Date();
  }

  /**
   * The PSP/card network's final decision. Reachable directly from
   * NEEDS_RESPONSE too — a dispute can be auto-decided without the merchant
   * ever formally submitting evidence (e.g. it's withdrawn, or the response
   * window lapses).
   */
  resolve(outcome: 'WON' | 'LOST'): void {
    if (this._status === 'WON' || this._status === 'LOST') {
      throw new Error(`Dispute is already resolved: ${this._status}`);
    }
    this._status = outcome;
    this._updatedAt = new Date();
  }

  get id(): string { return this._id; }
  get paymentId(): string { return this._paymentId; }
  get merchantId(): string { return this._merchantId; }
  get pspProvider(): PSPProvider { return this._pspProvider; }
  get pspDisputeId(): string { return this._pspDisputeId; }
  get amount(): Money { return this._amount; }
  get reason(): string | undefined { return this._reason; }
  get status(): DisputeStatus { return this._status; }
  get respondBy(): Date { return this._respondBy; }
  get evidence(): string | undefined { return this._evidence; }
  get createdAt(): Date { return this._createdAt; }
  get updatedAt(): Date { return this._updatedAt; }
  get autoDecision(): DisputeAutoDecision | undefined { return this._autoDecision; }
}
