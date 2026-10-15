import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Headers,
  UseGuards,
  UseInterceptors,
  Req,
  HttpCode,
  HttpStatus,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiHeader, ApiResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../shared/guards/roles.guard';
import { HmacSignatureGuard } from '../../../../shared/guards/hmac-signature.guard';
import { Roles, UserRole } from '../../../../shared/decorators/roles.decorator';
import { IdempotencyInterceptor } from '../interceptors/idempotency.interceptor';
import { BnplService } from '../services/bnpl.service';
import { CreateBnplOrderDto, RefundBnplOrderDto, BnplOrderResponseDto } from '../dto/bnpl.dto';
import { Money } from '../../domain/value-objects/money.vo';
import { BnplOrder } from '../../domain/aggregates/bnpl-order.aggregate';

function toResponse(order: BnplOrder): BnplOrderResponseDto {
  return {
    id: order.id,
    merchantId: order.merchantId,
    amount: order.amount.amount,
    currency: order.amount.currency.code,
    status: order.status,
    customerId: order.customerId,
    description: order.description,
    providerOrderId: order.providerOrderId,
    providerCaptureId: order.providerCaptureId,
    failureReason: order.failureReason,
    refunds: order.refunds.map((r) => ({
      refundId: r.refundId,
      amount: r.amount.amount,
      reason: r.reason,
      createdAt: r.createdAt.toISOString(),
      providerRefundId: r.providerRefundId,
    })),
    createdAt: order.createdAt.toISOString(),
    capturedAt: order.capturedAt?.toISOString(),
  };
}

/**
 * BNPL Controller
 * Klarna buy-now-pay-later orders — see `BnplOrder`/`BnplService`'s
 * own docblocks for why this is a separate mechanism from
 * `PaymentController`'s card-charge endpoints rather than another
 * payment method branch inside them.
 */
@ApiTags('BNPL v1')
@ApiBearerAuth()
@Controller('bnpl')
@UseGuards(JwtAuthGuard, RolesGuard)
export class BnplController {
  constructor(private readonly bnplService: BnplService) {}

  private assertOwnership(order: BnplOrder, req: any): void {
    if (req.user?.roles?.includes(UserRole.MERCHANT) && order.merchantId !== req.user.merchantId) {
      throw new ForbiddenException({ statusCode: 403, error: 'Forbidden', code: 'ACCESS_DENIED' });
    }
  }

  @Post('orders')
  @HttpCode(HttpStatus.CREATED)
  @Roles(UserRole.MERCHANT, UserRole.ADMIN)
  @UseGuards(HmacSignatureGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiOperation({ summary: 'Create and capture a Klarna BNPL order — see BnplOrder/BnplService own docblocks' })
  @ApiResponse({ status: 201, type: BnplOrderResponseDto })
  @ApiResponse({ status: 400, description: 'Missing Idempotency-Key header' })
  @ApiResponse({ status: 422, description: 'Klarna rejected the order, or capture failed' })
  @ApiHeader({ name: 'Idempotency-Key', description: 'UUID v4 for idempotent requests', required: true })
  async createOrder(
    @Body() dto: CreateBnplOrderDto,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() req: any,
  ): Promise<BnplOrderResponseDto> {
    if (!idempotencyKey) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Idempotency-Key header is required',
        code: 'MISSING_IDEMPOTENCY_KEY',
      });
    }
    const merchantId = req.user?.merchantId;
    const order = await this.bnplService.createOrder({
      merchantId,
      amount: Money.of(dto.amount, dto.currency),
      idempotencyKey,
      customerId: dto.customerId,
      description: dto.description,
    });
    return toResponse(order);
  }

  @Get('orders/:id')
  @Roles(UserRole.MERCHANT, UserRole.ADMIN, UserRole.READONLY)
  @ApiOperation({ summary: 'Get a single BNPL order by id' })
  @ApiResponse({ status: 200, type: BnplOrderResponseDto })
  @ApiResponse({ status: 404, description: 'Order not found' })
  async getById(@Param('id') id: string, @Req() req: any): Promise<BnplOrderResponseDto> {
    const order = await this.bnplService.findById(id);
    if (!order) {
      throw new NotFoundException({
        statusCode: 404,
        error: `BNPL order ${id} not found`,
        code: 'BNPL_ORDER_NOT_FOUND',
      });
    }
    this.assertOwnership(order, req);
    return toResponse(order);
  }

  @Post('orders/:id/refund')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.MERCHANT, UserRole.ADMIN)
  @UseGuards(HmacSignatureGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiOperation({ summary: 'Refund a captured BNPL order, in full or in part — routed back through Klarna itself' })
  @ApiResponse({ status: 200, type: BnplOrderResponseDto })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiResponse({ status: 409, description: 'Order is not in a refundable state' })
  @ApiResponse({ status: 422, description: 'Klarna declined the refund' })
  async refund(
    @Param('id') id: string,
    @Body() dto: RefundBnplOrderDto,
    @Req() req: any,
  ): Promise<BnplOrderResponseDto> {
    const existing = await this.bnplService.findById(id);
    if (!existing) {
      throw new NotFoundException({
        statusCode: 404,
        error: `BNPL order ${id} not found`,
        code: 'BNPL_ORDER_NOT_FOUND',
      });
    }
    this.assertOwnership(existing, req);
    const order = await this.bnplService.refundOrder(
      id,
      Money.of(dto.amount, existing.amount.currency.code),
      dto.reason,
    );
    return toResponse(order);
  }
}
