import { Controller, Patch, Post, Body, Param, Req, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../shared/guards/roles.guard';
import { Roles, UserRole } from '../../../../shared/decorators/roles.decorator';
import { MerchantService } from '../../../merchant/merchant.service';
import { toSummary } from '../../../merchant/merchant-admin.controller';
import { AmbiguousRiskMonitoringService } from '../services/ambiguous-risk-monitoring.service';
import { UpdateAmbiguousRiskFlagDto, UpdateAmbiguousRiskAutoDto, MerchantSummaryDto } from '../../../merchant/dto/create-merchant.dto';

/**
 * Ambiguous Risk Admin Controller — see AmbiguousRiskMonitoringService's
 * docblock. Manual override of, and on-demand trigger for, the automated
 * flag/auto-clear logic — purely observational, does not change how any
 * merchant's charges are processed.
 */
@ApiTags('Admin — Ambiguous Risk Monitoring')
@ApiBearerAuth()
@Controller('admin/merchants')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.OPERATOR)
export class AmbiguousRiskAdminController {
  constructor(
    private readonly merchantService: MerchantService,
    private readonly ambiguousRiskMonitoring: AmbiguousRiskMonitoringService,
  ) {}

  @Patch(':merchantId/ambiguous-risk')
  @ApiOperation({ summary: 'Manually flag or clear a merchant\'s ambiguous-risk observation status — reason is required and, along with the acting admin/operator\'s identity, is recorded as a permanent audit trail. Disables ambiguousRiskAutoManaged as a side effect, same "manual input pauses automation" behavior as PATCH .../risk-tier-auto.' })
  @ApiResponse({ status: 200, type: MerchantSummaryDto })
  @ApiResponse({ status: 404, description: 'Merchant not found' })
  async setFlag(@Param('merchantId') merchantId: string, @Body() dto: UpdateAmbiguousRiskFlagDto, @Req() req: any): Promise<MerchantSummaryDto> {
    const merchant = await this.merchantService.setAmbiguousRiskFlagManual(merchantId, dto.flagged, dto.reason, req.user.merchantId);
    return toSummary(merchant);
  }

  @Patch(':merchantId/ambiguous-risk-auto')
  @ApiOperation({ summary: 'Re-enable AmbiguousRiskMonitoringService\'s automated flag/auto-clear logic for this merchant, after a manual PATCH .../ambiguous-risk disabled it.' })
  @ApiResponse({ status: 200, type: MerchantSummaryDto })
  @ApiResponse({ status: 404, description: 'Merchant not found' })
  async setAutoManaged(@Param('merchantId') merchantId: string, @Body() dto: UpdateAmbiguousRiskAutoDto): Promise<MerchantSummaryDto> {
    const merchant = await this.merchantService.setAmbiguousRiskAutoManaged(merchantId, dto.enabled);
    return toSummary(merchant);
  }

  @Post('ambiguous-risk/run-auto-clear')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Trigger the daily auto-clear sweep on demand — the same logic the 3am @Cron runs, without waiting for the schedule. Only clears merchants with ambiguousRiskAutoManaged: true whose most recent AMBIGUOUS incident is older than AMBIGUOUS_RISK_AUTO_CLEAR_DAYS.' })
  @ApiResponse({ status: 200, description: '{ cleared: number }' })
  async runAutoClear(): Promise<{ cleared: number }> {
    return this.ambiguousRiskMonitoring.runAutoClearSweep();
  }
}
