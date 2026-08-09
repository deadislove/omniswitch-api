import { Controller, Get, Post, Param, Query, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OutboxRecoveryService } from '../services/outbox-recovery.service';
import { JwtAuthGuard } from '../../../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../shared/guards/roles.guard';
import { Roles, UserRole } from '../../../../shared/decorators/roles.decorator';
import { LedgerOutboxEvent } from '../../domain/aggregates/ledger-outbox.aggregate';

class OutboxEventSummaryDto {
  @ApiProperty({ example: 'a1b2c3d4-...' })
  id: string;

  @ApiProperty({ example: 'pay_abc123' })
  paymentId: string;

  @ApiProperty({ example: 'PAYMENT_CHARGED' })
  eventType: string;

  @ApiProperty({ enum: ['PENDING', 'PUBLISHED', 'FAILED'] })
  status: string;

  @ApiProperty({ example: 0 })
  retryCount: number;

  @ApiPropertyOptional({ example: 'Connection refused' })
  lastError?: string;

  @ApiProperty()
  createdAt: string;

  @ApiPropertyOptional()
  processedAt?: string;
}

class RetryResponseDto {
  @ApiProperty({ example: 'a1b2c3d4-...' })
  id: string;

  @ApiProperty({ example: 'PENDING' })
  status: string;
}

function toSummary(event: LedgerOutboxEvent): OutboxEventSummaryDto {
  return {
    id: event.id,
    paymentId: event.paymentId,
    eventType: event.eventType,
    status: event.status,
    retryCount: event.retryCount,
    lastError: event.lastError,
    createdAt: event.createdAt.toISOString(),
    processedAt: event.processedAt?.toISOString(),
  };
}

/**
 * Outbox Admin Controller
 * Operator-facing recovery for dead-lettered ledger outbox events — see
 * OutboxRecoveryService's docblock for why this exists (markFailed() is
 * deliberately terminal, not auto-retried).
 */
@ApiTags('Admin — Ledger Outbox')
@ApiBearerAuth()
@Controller('admin/outbox')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.OPERATOR)
export class OutboxAdminController {
  constructor(private readonly outboxRecovery: OutboxRecoveryService) {}

  @Get('failed')
  @ApiOperation({ summary: 'List dead-lettered (FAILED) ledger outbox events awaiting operator review' })
  @ApiResponse({ status: 200, type: [OutboxEventSummaryDto] })
  async listFailed(@Query('limit') limit?: string): Promise<OutboxEventSummaryDto[]> {
    const events = await this.outboxRecovery.listFailed(limit ? Number(limit) : undefined);
    return events.map(toSummary);
  }

  @Post(':id/retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset a FAILED event back to PENDING so the relay retries it on its next tick' })
  @ApiResponse({ status: 200, type: RetryResponseDto })
  @ApiResponse({ status: 404, description: 'Outbox event not found' })
  @ApiResponse({ status: 409, description: 'Event is not currently FAILED (lost a race with another retry, or moved on)' })
  async retry(@Param('id') id: string): Promise<RetryResponseDto> {
    await this.outboxRecovery.retry(id);
    return { id, status: 'PENDING' };
  }
}
