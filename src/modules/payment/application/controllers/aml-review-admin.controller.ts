import { Controller, Patch, Body, Param, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../shared/guards/roles.guard';
import { Roles, UserRole } from '../../../../shared/decorators/roles.decorator';
import { MerchantService } from '../../../merchant/merchant.service';
import { toSummary } from '../../../merchant/merchant-admin.controller';
import { UpdateAmlReviewFlagDto, UpdateAmlReviewAutoDto, MerchantSummaryDto } from '../../../merchant/dto/create-merchant.dto';

/**
 * AML Review Admin Controller — see AmlReviewMonitoringService's
 * docblock. Manual override of the automated flag logic — purely
 * observational, does not change how any merchant's charges are
 * processed. No run-now/auto-clear endpoint (unlike
 * AmbiguousRiskAdminController): a HIGH-industry merchant's hard-decline
 * history doesn't "age out" the way an ambiguous-outcome incident does —
 * an AML-review flag is meant to stay live until a human actually
 * clears it (PATCH .../aml-review with flagged: false), not expire on a
 * timer.
 */
@ApiTags('Admin — AML Review Monitoring')
@ApiBearerAuth()
@Controller('admin/merchants')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.OPERATOR)
export class AmlReviewAdminController {
  constructor(private readonly merchantService: MerchantService) {}

  @Patch(':merchantId/aml-review')
  @ApiOperation({
    summary:
      'Manually flag or clear a merchant\'s AML-review observation status — reason is required and, along with the acting admin/operator\'s identity, is recorded as a permanent audit trail. Disables amlReviewAutoManaged as a side effect, same "manual input pauses automation" behavior as PATCH .../ambiguous-risk.',
  })
  @ApiResponse({ status: 200, type: MerchantSummaryDto })
  @ApiResponse({ status: 404, description: 'Merchant not found' })
  async setFlag(
    @Param('merchantId') merchantId: string,
    @Body() dto: UpdateAmlReviewFlagDto,
    @Req() req: any,
  ): Promise<MerchantSummaryDto> {
    const merchant = await this.merchantService.setAmlReviewFlagManual(
      merchantId,
      dto.flagged,
      dto.reason,
      req.user.merchantId,
    );
    return toSummary(merchant);
  }

  @Patch(':merchantId/aml-review-auto')
  @ApiOperation({
    summary:
      "Re-enable AmlReviewMonitoringService's automated flag logic for this merchant, after a manual PATCH .../aml-review disabled it.",
  })
  @ApiResponse({ status: 200, type: MerchantSummaryDto })
  @ApiResponse({ status: 404, description: 'Merchant not found' })
  async setAutoManaged(
    @Param('merchantId') merchantId: string,
    @Body() dto: UpdateAmlReviewAutoDto,
  ): Promise<MerchantSummaryDto> {
    const merchant = await this.merchantService.setAmlReviewAutoManaged(merchantId, dto.enabled);
    return toSummary(merchant);
  }
}
