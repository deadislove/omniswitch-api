import { Controller, Post, Delete, Param, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse, ApiProperty } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../shared/guards/roles.guard';
import { Roles, UserRole } from '../../../../shared/decorators/roles.decorator';
import { LegalHoldService } from '../services/legal-hold.service';

class LegalHoldResponseDto {
  @ApiProperty({ example: 'a1b2c3d4-...' })
  id: string;

  @ApiProperty()
  legalHold: boolean;

  @ApiProperty({
    enum: ['live', 'restored-from-archive'],
    description: 'Where the payment now lives. "restored-from-archive" means placing this hold moved it out of cold storage and back into the live table.',
  })
  location: 'live' | 'restored-from-archive';
}

/**
 * Legal Hold Admin Controller (Phase 3 follow-up #5 — see
 * docs/compliance/data-retention.md). Blocks a payment from ever being
 * archived or deleted by the retention jobs while held, regardless of
 * age or dispute status — see LegalHoldService's docblock for the full
 * design, including why placing a hold on an already-archived payment
 * restores it to the live table rather than flagging it in place.
 */
@ApiTags('Admin — Legal Hold')
@ApiBearerAuth()
@Controller('admin/payments')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.OPERATOR)
export class LegalHoldAdminController {
  constructor(private readonly legalHoldService: LegalHoldService) {}

  @Post(':id/legal-hold')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Place a legal hold on a payment — excludes it from archiving/deletion regardless of age or dispute status until released. Restores it from archive to the live table if it was already archived.' })
  @ApiResponse({ status: 200, type: LegalHoldResponseDto })
  @ApiResponse({ status: 404, description: 'Payment not found' })
  async placeHold(@Param('id') id: string): Promise<LegalHoldResponseDto> {
    return this.legalHoldService.placeHold(id);
  }

  @Delete(':id/legal-hold')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Release a legal hold — the payment becomes archive-eligible again (via the normal archiving job) once its age/status/dispute conditions are otherwise met.' })
  @ApiResponse({ status: 200, type: LegalHoldResponseDto })
  @ApiResponse({ status: 404, description: 'Payment not found among live payments' })
  async releaseHold(@Param('id') id: string): Promise<LegalHoldResponseDto> {
    return this.legalHoldService.releaseHold(id);
  }
}
