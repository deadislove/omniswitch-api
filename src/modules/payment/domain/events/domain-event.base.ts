import { v4 as uuidv4 } from 'uuid';

/**
 * Base class for all Domain Events.
 * Domain Events are immutable records of something that happened in the domain.
 */
export abstract class DomainEvent {
  readonly eventId: string;
  readonly occurredAt: Date;
  readonly aggregateId: string;
  readonly aggregateType: string;
  readonly eventVersion: number;

  constructor(params: {
    aggregateId: string;
    aggregateType: string;
    eventVersion?: number;
  }) {
    this.eventId = uuidv4();
    this.occurredAt = new Date();
    this.aggregateId = params.aggregateId;
    this.aggregateType = params.aggregateType;
    this.eventVersion = params.eventVersion ?? 1;
  }

  abstract get eventName(): string;
}
