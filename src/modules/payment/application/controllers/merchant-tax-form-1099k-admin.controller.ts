import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../shared/guards/roles.guard';
import { Roles, UserRole } from '../../../../shared/decorators/roles.decorator';
import { TaxForm1099KService } from '../services/tax-form-1099k.service';
import { MerchantTaxFormPort } from '../../ports/outbound/merchant-tax-form.port';
import {
  GenerateTaxForm1099KDto,
  MerchantTaxForm1099KResponseDto,
  toMerchantTaxForm1099KResponseDto,
} from '../dto/merchant-tax-form-1099k.dto';

/**
 * Merchant 1099-K Admin Controller
 * Operator-facing trigger/view — see `TaxForm1099KService`'s own
 * docblock for the dual on-demand + scheduled shape this follows.
 */
@ApiTags('Admin — Merchant 1099-K Tax Forms')
@ApiBearerAuth()
@Controller('admin/merchants/:id/tax-forms/1099k')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.OPERATOR)
export class MerchantTaxForm1099KAdminController {
  constructor(
    private readonly taxFormService: TaxForm1099KService,
    private readonly taxFormPort: MerchantTaxFormPort,
  ) {}

  @Get()
  @ApiOperation({ summary: "List a merchant's 1099-K forms, most recent tax year first" })
  @ApiResponse({ status: 200, type: [MerchantTaxForm1099KResponseDto] })
  async list(
    @Param('id') merchantId: string,
    @Query('limit') limit?: string,
  ): Promise<MerchantTaxForm1099KResponseDto[]> {
    const forms = await this.taxFormPort.findByMerchantId(merchantId, { limit: limit ? Number(limit) : undefined });
    return forms.map(toMerchantTaxForm1099KResponseDto);
  }

  @Post('generate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Generate a 1099-K for a merchant/tax-year on demand, regardless of country — idempotent, returns the existing one if already generated',
  })
  @ApiResponse({ status: 200, type: MerchantTaxForm1099KResponseDto })
  @ApiResponse({ status: 404, description: 'No ledger activity at all for this merchant in that tax year' })
  async generate(
    @Param('id') merchantId: string,
    @Body() dto: GenerateTaxForm1099KDto,
  ): Promise<MerchantTaxForm1099KResponseDto> {
    const form = await this.taxFormService.generateForMerchant(merchantId, dto.taxYear);
    if (!form) {
      throw new NotFoundException({
        statusCode: 404,
        error: `Merchant ${merchantId} has no ledger activity in tax year ${dto.taxYear}`,
        code: 'NO_ACTIVITY_IN_TAX_YEAR',
      });
    }
    return toMerchantTaxForm1099KResponseDto(form);
  }
}
