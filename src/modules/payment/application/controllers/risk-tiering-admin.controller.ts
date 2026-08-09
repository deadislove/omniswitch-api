import { Controller, Post, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse, ApiProperty } from '@nestjs/swagger';
import { RiskTieringService } from '../services/risk-tiering.service';
import { JwtAuthGuard } from '../../../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../shared/guards/roles.guard';
import { Roles, UserRole } from '../../../../shared/decorators/roles.decorator';

class TieringSweepResultDto {
  @ApiProperty({ example: 12, description: 'Auto-managed merchants with enough charge volume to evaluate' })
  evaluated: number;

  @ApiProperty({ example: 2, description: 'Evaluated merchants whose reserve policy actually changed' })
  changed: number;

  @ApiProperty({ example: 3, description: 'Auto-managed merchants skipped — not enough settled-charge volume in the trailing window to evaluate, or an error' })
  skipped: number;
}

/**
 * Risk Tiering Admin Controller
 * On-demand trigger for RiskTieringService.runTieringSweep() — same dual
 * on-demand + scheduled shape as ReconciliationService/ReserveService/
 * SubscriptionService's billing sweep.
 */
@ApiTags('Admin — Risk Tiering')
@ApiBearerAuth()
@Controller('admin/risk-tiering')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.OPERATOR)
export class RiskTieringAdminController {
  constructor(private readonly riskTieringService: RiskTieringService) {}

  @Post('run')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Run the risk tiering sweep now instead of waiting for the daily schedule' })
  @ApiResponse({ status: 200, type: TieringSweepResultDto })
  async run(): Promise<TieringSweepResultDto> {
    return this.riskTieringService.runTieringSweep();
  }
}
