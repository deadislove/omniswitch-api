import { Controller, Patch, Body, Param, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../shared/guards/roles.guard';
import { Roles, UserRole } from '../../../../shared/decorators/roles.decorator';
import { MerchantService } from '../../../merchant/merchant.service';
import { toSummary } from '../../../merchant/merchant-admin.controller';
import {
  UpdateChargebackMonitoringTierDto,
  UpdateChargebackMonitoringAutoDto,
  MerchantSummaryDto,
} from '../../../merchant/dto/create-merchant.dto';

/**
 * Chargeback Monitoring Admin Controller — see
 * `ChargebackMonitoringService`'s docblock. Manual override of the
 * automated tier logic — same visibility/compliance-tracking posture
 * as `AmlReviewAdminController`; this is purely informational and
 * doesn't block charge processing. No
 * run-now endpoint (unlike `AmbiguousRiskAdminController`): a
 * dispute-rate history doesn't "age out" the way an ambiguous-outcome
 * incident does, so there's nothing a run-now call would meaningfully
 * resolve faster than the next scheduled sweep.
 */
@ApiTags('Admin — Chargeback Monitoring Program')
@ApiBearerAuth()
@Controller('admin/merchants')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.OPERATOR)
export class ChargebackMonitoringAdminController {
  constructor(private readonly merchantService: MerchantService) {}

  @Patch(':merchantId/chargeback-monitoring')
  @ApiOperation({
    summary:
      'Manually set or clear a merchant\'s chargeback-monitoring-program tier — reason is required and, along with the acting admin/operator\'s identity, is recorded as a permanent audit trail. Disables chargebackMonitoringAutoManaged as a side effect, same "manual input pauses automation" behavior as PATCH .../aml-review.',
  })
  @ApiResponse({ status: 200, type: MerchantSummaryDto })
  @ApiResponse({ status: 404, description: 'Merchant not found' })
  async setTier(
    @Param('merchantId') merchantId: string,
    @Body() dto: UpdateChargebackMonitoringTierDto,
    @Req() req: any,
  ): Promise<MerchantSummaryDto> {
    const merchant = await this.merchantService.setChargebackMonitoringTierManual(
      merchantId,
      dto.tier,
      dto.reason,
      req.user.merchantId,
    );
    return toSummary(merchant);
  }

  @Patch(':merchantId/chargeback-monitoring-auto')
  @ApiOperation({
    summary:
      "Re-enable ChargebackMonitoringService's automated tier logic for this merchant, after a manual PATCH .../chargeback-monitoring disabled it.",
  })
  @ApiResponse({ status: 200, type: MerchantSummaryDto })
  @ApiResponse({ status: 404, description: 'Merchant not found' })
  async setAutoManaged(
    @Param('merchantId') merchantId: string,
    @Body() dto: UpdateChargebackMonitoringAutoDto,
  ): Promise<MerchantSummaryDto> {
    const merchant = await this.merchantService.setChargebackMonitoringAutoManaged(merchantId, dto.enabled);
    return toSummary(merchant);
  }
}
