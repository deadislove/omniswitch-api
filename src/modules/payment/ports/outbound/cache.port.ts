/**
 * Cache Port (Outbound)
 * Defines the contract for distributed cache and locking operations.
 * Redis implementation lives in the adapters layer.
 */
export abstract class CachePort {
  /**
   * Get a value from cache
   */
  abstract get<T>(key: string): Promise<T | null>;

  /**
   * Set a value in cache with optional TTL (seconds)
   */
  abstract set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;

  /**
   * Delete a key from cache
   */
  abstract del(key: string): Promise<void>;

  /**
   * Check if a key exists
   */
  abstract exists(key: string): Promise<boolean>;

  /**
   * Atomic Set-if-Not-Exists (SETNX) with TTL
   * Returns true if the key was set (lock acquired), false if already exists
   * Used for distributed idempotency locking.
   */
  abstract setNX(key: string, value: string, ttlSeconds: number): Promise<boolean>;

  /**
   * Increment a counter atomically
   */
  abstract incr(key: string): Promise<number>;

  /**
   * Set expiry on an existing key
   */
  abstract expire(key: string, ttlSeconds: number): Promise<void>;

  /**
   * Get remaining TTL of a key in seconds
   */
  abstract ttl(key: string): Promise<number>;

  /**
   * Execute multiple commands atomically (pipeline)
   */
  abstract pipeline(commands: Array<[string, ...unknown[]]>): Promise<unknown[]>;
}
