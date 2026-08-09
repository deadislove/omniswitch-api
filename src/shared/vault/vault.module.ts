import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { VaultTransitService } from './vault-transit.service';

@Module({
  imports: [ConfigModule],
  providers: [VaultTransitService],
  exports: [VaultTransitService],
})
export class VaultModule {}
