import { Controller, Post, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse, ApiProperty } from '@nestjs/swagger';
import { SanctionsScreeningSweepService } from './sanctions-screening-sweep.service';
import { JwtAuthGuard } from '../../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../../shared/guards/roles.guard';
import { Roles, UserRole } from '../../../shared/decorators/roles.decorator';

class SanctionsSweepResultDto {
  @ApiProperty({ example: 120, description: 'Active merchants not already HIT, screened this run' })
  screened: number;

  @ApiProperty({ example: 0, description: 'Merchants newly matched at HIT confidence this run' })
  newHits: number;

  @ApiProperty({ example: 1, description: 'Merchants newly matched at POTENTIAL_MATCH confidence this run' })
  newPotentialMatches: number;

  @ApiProperty({ example: 0, description: 'Merchants skipped due to a screening-call error' })
  skipped: number;
}

/**
 * Sanctions Admin Controller
 * On-demand trigger for SanctionsScreeningSweepService.runSweep() — same
 * dual on-demand + scheduled shape as RiskTieringAdminController/
 * ReconciliationService/ReserveService.
 */
@ApiTags('Admin — Sanctions Screening')
@ApiBearerAuth()
@Controller('admin/sanctions')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.OPERATOR)
export class SanctionsAdminController {
  constructor(private readonly sweepService: SanctionsScreeningSweepService) {}

  @Post('run')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Run the sanctions/watchlist re-screening sweep now instead of waiting for the weekly schedule',
  })
  @ApiResponse({ status: 200, type: SanctionsSweepResultDto })
  async run(): Promise<SanctionsSweepResultDto> {
    return this.sweepService.runSweep();
  }
}
