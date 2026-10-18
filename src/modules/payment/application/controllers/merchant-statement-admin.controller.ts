import { Controller, Get, Post, Param, Body, Query, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../shared/guards/roles.guard';
import { Roles, UserRole } from '../../../../shared/decorators/roles.decorator';
import { MerchantStatementService } from '../services/merchant-statement.service';
import { MerchantStatementPort } from '../../ports/outbound/merchant-statement.port';
import {
  GenerateMerchantStatementDto,
  MerchantStatementResponseDto,
  toMerchantStatementResponseDto,
} from '../dto/merchant-statement.dto';

const toResponse = toMerchantStatementResponseDto;

/**
 * Merchant Statement Admin Controller
 * Operator-facing trigger/view for a merchant's statements — see
 * `MerchantStatementService`'s own docblock for the dual on-demand +
 * scheduled shape this follows.
 */
@ApiTags('Admin — Merchant Statements')
@ApiBearerAuth()
@Controller('admin/merchants/:id/statements')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.OPERATOR)
export class MerchantStatementAdminController {
  constructor(
    private readonly statementService: MerchantStatementService,
    private readonly statementPort: MerchantStatementPort,
  ) {}

  @Get()
  @ApiOperation({ summary: "List a merchant's statements, most recent period first" })
  @ApiResponse({ status: 200, type: [MerchantStatementResponseDto] })
  async list(@Param('id') merchantId: string, @Query('limit') limit?: string): Promise<MerchantStatementResponseDto[]> {
    const statements = await this.statementPort.findByMerchantId(merchantId, {
      limit: limit ? Number(limit) : undefined,
    });
    return statements.map(toResponse);
  }

  @Post('generate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Generate a statement for a merchant/period on demand — idempotent, returns the existing one if already generated',
  })
  @ApiResponse({ status: 200, type: MerchantStatementResponseDto })
  async generate(
    @Param('id') merchantId: string,
    @Body() dto: GenerateMerchantStatementDto,
  ): Promise<MerchantStatementResponseDto> {
    const statement = await this.statementService.generateForMerchant(
      merchantId,
      new Date(dto.periodStart),
      new Date(dto.periodEnd),
    );
    return toResponse(statement);
  }
}
