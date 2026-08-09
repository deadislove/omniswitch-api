import { Controller, Post, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { SubscriptionService } from '../services/subscription.service';
import { JwtAuthGuard } from '../../../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../shared/guards/roles.guard';
import { Roles, UserRole } from '../../../../shared/decorators/roles.decorator';
import { BillingSweepResultDto } from '../dto/subscription.dto';

/**
 * Subscription Admin Controller
 * On-demand trigger for SubscriptionService.runBillingSweep() — same dual
 * on-demand + scheduled shape as ReconciliationService/ReserveService, so
 * an operator (or a test) doesn't have to wait for the daily schedule.
 */
@ApiTags('Admin — Subscriptions')
@ApiBearerAuth()
@Controller('admin/subscriptions')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.OPERATOR)
export class SubscriptionAdminController {
  constructor(private readonly subscriptionService: SubscriptionService) {}

  @Post('run-billing')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Run the subscription billing sweep now instead of waiting for the daily schedule' })
  @ApiResponse({ status: 200, type: BillingSweepResultDto })
  async runBilling(): Promise<BillingSweepResultDto> {
    return this.subscriptionService.runBillingSweep();
  }
}
