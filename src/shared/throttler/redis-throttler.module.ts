import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RedisThrottlerStorage } from './redis-throttler-storage.service';

/**
 * Wraps RedisThrottlerStorage as its own module so it can be injected into
 * ThrottlerModule.forRootAsync()'s factory via Nest's normal DI (rather than
 * `new`-ing it directly inside the factory, which would skip its
 * OnModuleDestroy lifecycle hook and leave the Redis connection dangling on
 * shutdown).
 */
@Module({
  imports: [ConfigModule],
  providers: [RedisThrottlerStorage],
  exports: [RedisThrottlerStorage],
})
export class RedisThrottlerModule {}
