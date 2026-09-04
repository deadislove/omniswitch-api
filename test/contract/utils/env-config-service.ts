/**
 * A minimal `ConfigService`-shaped object reading directly from
 * `process.env`, for constructing an adapter (`StripePSPAdapter`,
 * `RedisCacheAdapter`, ...) outside the full Nest DI container. Contract
 * tests target one adapter class directly against a real external API —
 * booting the whole app (`test/utils/test-app.ts`'s approach) would pull
 * in Postgres/Vault/every other module for no reason here.
 */
export class EnvConfigService {
  get<T = string>(key: string, defaultValue?: T): T {
    const value = process.env[key];
    if (value === undefined) return defaultValue as T;
    return value as unknown as T;
  }
}
