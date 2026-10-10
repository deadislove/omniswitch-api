import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
  ApiProperty,
  ApiPropertyOptional,
  ApiQuery,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../shared/guards/roles.guard';
import { Roles, UserRole } from '../../../../shared/decorators/roles.decorator';
import { WebhookDeliveryLogService } from '../../../../shared/webhook-delivery-log/webhook-delivery-log.service';
import { WebhookDeliveryLogEntity } from '../../../../shared/webhook-delivery-log/webhook-delivery-log.entity';
import { WebhookDeliveryReplayService } from '../services/webhook-delivery-replay.service';

class WebhookDeliveryDto {
  @ApiProperty({ example: 'a1b2c3d4-...' })
  id: string;

  @ApiProperty({ example: 'merchant_acme_corp' })
  merchantId: string;

  @ApiProperty({
    example: 'dispute.created',
    description:
      "The notification's own event field — 'dispute.created'/'dispute.resolved', 'subscription.past_due'/'subscription.canceled', 'aml_review.flagged', or 'sanctions_screening.flagged'.",
  })
  eventType: string;

  @ApiProperty({ example: 'https://example.com/webhooks/omniswitch' })
  targetUrl: string;

  @ApiProperty({ description: 'The exact JSON body that was (or, for a replay, will be) sent.' })
  payload: Record<string, unknown>;

  @ApiProperty({ example: true })
  success: boolean;

  @ApiPropertyOptional({
    example: 200,
    nullable: true,
    description:
      'Null when the failure was a network error/timeout — there was never a response to read a status from.',
  })
  statusCode: number | null;

  @ApiPropertyOptional({ example: null, nullable: true })
  errorMessage: string | null;

  @ApiProperty({ example: 142 })
  latencyMs: number;

  @ApiPropertyOptional({
    example: null,
    nullable: true,
    description: 'Set when this row is a manual replay — the original delivery this replayed, never a chain.',
  })
  replayOfDeliveryId: string | null;

  @ApiProperty()
  createdAt: string;
}

function toDto(entity: WebhookDeliveryLogEntity): WebhookDeliveryDto {
  return {
    id: entity.id,
    merchantId: entity.merchantId,
    eventType: entity.eventType,
    targetUrl: entity.targetUrl,
    payload: entity.payload,
    success: entity.success,
    statusCode: entity.statusCode ?? null,
    errorMessage: entity.errorMessage ?? null,
    latencyMs: entity.latencyMs,
    replayOfDeliveryId: entity.replayOfDeliveryId ?? null,
    createdAt: entity.createdAt.toISOString(),
  };
}

/**
 * Webhook Delivery Admin Controller
 * A merchant-facing-in-spirit, admin-surfaced log of every WEBHOOK-
 * channel notification delivery attempt (dispute/subscription/AML-
 * review/sanctions-screening) — see
 * `WebhookDeliveryLogEntity`'s own docblock for why this is WEBHOOK-
 * channel only, and `WebhookDeliveryReplayService`'s docblock for why
 * replay is generic across all four families. `ADMIN`/`OPERATOR` only,
 * same visibility scope this codebase already uses for dispute admin
 * endpoints (`GET /admin/disputes`) rather than a new merchant-self-
 * service pattern this codebase doesn't otherwise have.
 */
@ApiTags('Admin — Webhook Deliveries')
@ApiBearerAuth()
@Controller('admin/webhook-deliveries')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.OPERATOR)
export class WebhookDeliveryAdminController {
  constructor(
    private readonly deliveryLog: WebhookDeliveryLogService,
    private readonly replayService: WebhookDeliveryReplayService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List webhook delivery attempts for a merchant, newest first' })
  @ApiQuery({ name: 'merchantId', required: true })
  @ApiQuery({ name: 'eventType', required: false })
  @ApiQuery({ name: 'success', required: false, type: Boolean })
  @ApiQuery({
    name: 'afterId',
    required: false,
    description: 'Keyset cursor — pass the last id from the previous page',
  })
  @ApiQuery({ name: 'limit', required: false, description: 'Default 50, max 200' })
  @ApiResponse({ status: 200, type: [WebhookDeliveryDto] })
  async list(
    @Query('merchantId') merchantId: string,
    @Query('eventType') eventType?: string,
    @Query('success') success?: string,
    @Query('afterId') afterId?: string,
    @Query('limit') limit?: string,
  ): Promise<WebhookDeliveryDto[]> {
    const parsedLimit = Math.min(Number(limit) || 50, 200);
    const parsedSuccess = success === undefined ? undefined : success === 'true';
    const deliveries = await this.deliveryLog.findByMerchant(
      merchantId,
      { eventType, success: parsedSuccess },
      afterId,
      parsedLimit,
    );
    return deliveries.map(toDto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one webhook delivery attempt, including its full payload' })
  @ApiResponse({ status: 200, type: WebhookDeliveryDto })
  @ApiResponse({ status: 404, description: 'Delivery not found' })
  async get(@Param('id') id: string): Promise<WebhookDeliveryDto> {
    const delivery = await this.deliveryLog.findById(id);
    if (!delivery) {
      throw new NotFoundException({
        statusCode: 404,
        error: `Webhook delivery ${id} not found`,
        code: 'WEBHOOK_DELIVERY_NOT_FOUND',
      });
    }
    return toDto(delivery);
  }

  @Post(':id/replay')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Re-send a delivery's exact payload to its exact target URL, re-signed with the merchant's current HMAC secret — records a new delivery row rather than mutating the original.",
  })
  @ApiResponse({ status: 200, type: WebhookDeliveryDto })
  @ApiResponse({ status: 404, description: 'Delivery not found' })
  @ApiResponse({ status: 422, description: 'HMAC_SECRET_MISSING — the merchant has no HMAC secret on file' })
  async replay(@Param('id') id: string): Promise<WebhookDeliveryDto> {
    const result = await this.replayService.replay(id);
    return toDto(result);
  }
}
