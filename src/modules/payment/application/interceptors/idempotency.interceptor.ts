import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Observable, from, throwError } from 'rxjs';
import { switchMap, catchError } from 'rxjs/operators';
import { CachePort } from '../../ports/outbound/cache.port';

const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
const IDEMPOTENCY_TTL_SECONDS = 86400; // 24 hours
const LOCK_TTL_SECONDS = 30; // 30 second processing lock
const IDEMPOTENCY_PREFIX = 'idempotency:';
const LOCK_PREFIX = 'idempotency:lock:';

interface IdempotencyRecord {
  status: 'PROCESSING' | 'COMPLETED';
  response?: unknown;
  statusCode?: number;
  completedAt?: string;
}

/**
 * Idempotency Interceptor
 * Prevents duplicate payment processing using Redis distributed lock (SETNX).
 *
 * Flow:
 * 1. Extract Idempotency-Key header
 * 2. Try to acquire distributed lock (SETNX with TTL)
 * 3. If lock acquired: process request, cache response, release lock
 * 4. If lock not acquired (concurrent request): return 409 Conflict
 * 5. If cached response exists: return cached response (idempotent replay)
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(private readonly cache: CachePort) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const idempotencyKey = request.headers[IDEMPOTENCY_KEY_HEADER];

    // Skip idempotency check if no key provided (non-idempotent endpoints)
    if (!idempotencyKey) {
      return next.handle();
    }

    // Validate key format (UUID v4)
    if (!this.isValidIdempotencyKey(idempotencyKey)) {
      throw new HttpException(
        {
          statusCode: HttpStatus.BAD_REQUEST,
          error: 'Invalid Idempotency-Key format. Must be a valid UUID v4.',
          code: 'INVALID_IDEMPOTENCY_KEY',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    // Scoped by merchant, not just the raw key — this interceptor runs
    // after JwtAuthGuard (see PaymentController's class-level @UseGuards
    // ordering), so req.user is already populated. Without this, a caller
    // who submits another merchant's *known* Idempotency-Key (leaked via
    // a logging bug, a shared support ticket) would get that merchant's
    // cached response replayed back — including its payment ID, PSP
    // transaction ID, and risk score — before the request ever reaches
    // the controller's own assertOwnership() check.
    const merchantId = request.user?.merchantId;
    const cacheKey = `${IDEMPOTENCY_PREFIX}${merchantId}:${idempotencyKey}`;
    const lockKey = `${LOCK_PREFIX}${merchantId}:${idempotencyKey}`;

    return from(this.processIdempotency(cacheKey, lockKey, idempotencyKey, context, next));
  }

  private async processIdempotency(
    cacheKey: string,
    lockKey: string,
    idempotencyKey: string,
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<unknown> {
    // ─── Check for existing cached response ──────────────────────────────────
    const existing = await this.cache.get<IdempotencyRecord>(cacheKey);

    if (existing) {
      if (existing.status === 'COMPLETED' && existing.response !== undefined) {
        this.logger.log(`Idempotency replay: key=${idempotencyKey}`);
        const response = context.switchToHttp().getResponse();
        response.status(existing.statusCode || 200);
        return existing.response;
      }

      if (existing.status === 'PROCESSING') {
        throw new HttpException(
          {
            statusCode: HttpStatus.CONFLICT,
            error: 'A request with this Idempotency-Key is currently being processed.',
            code: 'IDEMPOTENCY_CONFLICT',
            idempotencyKey,
          },
          HttpStatus.CONFLICT,
        );
      }
    }

    // ─── Acquire distributed lock (SETNX) ────────────────────────────────────
    const lockAcquired = await this.cache.setNX(
      lockKey,
      JSON.stringify({ acquiredAt: new Date().toISOString() }),
      LOCK_TTL_SECONDS,
    );

    if (!lockAcquired) {
      throw new HttpException(
        {
          statusCode: HttpStatus.CONFLICT,
          error: 'A request with this Idempotency-Key is currently being processed.',
          code: 'IDEMPOTENCY_LOCK_CONFLICT',
          idempotencyKey,
        },
        HttpStatus.CONFLICT,
      );
    }

    // Mark as PROCESSING
    await this.cache.set<IdempotencyRecord>(
      cacheKey,
      { status: 'PROCESSING' },
      IDEMPOTENCY_TTL_SECONDS,
    );

    this.logger.debug(`Idempotency lock acquired: key=${idempotencyKey}`);

    // ─── Execute the handler ──────────────────────────────────────────────────
    // Both branches below used to be `tap(async ...)` / `catchError(async ...)`.
    // Neither operator awaits a returned Promise: tap ignores it entirely (so
    // the response could reach the client before the cache write finished),
    // and catchError treats a returned Promise as a value to emit rather than
    // something to flatten — so `return throwError(() => error)` inside an
    // async function shipped the Observable *object* as a 200 response body
    // instead of propagating the error (e.g. an over-refund request that
    // should 409 would come back 200 with body `{}`). switchMap here
    // properly sequences the async cache work before resolving/rejecting.
    return new Promise((resolve, reject) => {
      next
        .handle()
        .pipe(
          switchMap((responseBody) =>
            from(
              (async () => {
                const httpResponse = context.switchToHttp().getResponse();
                const statusCode = httpResponse.statusCode || 200;

                await this.cache.set<IdempotencyRecord>(
                  cacheKey,
                  {
                    status: 'COMPLETED',
                    response: responseBody,
                    statusCode,
                    completedAt: new Date().toISOString(),
                  },
                  IDEMPOTENCY_TTL_SECONDS,
                );
                await this.cache.del(lockKey);
                this.logger.debug(`Idempotency response cached: key=${idempotencyKey}`);
                return responseBody;
              })(),
            ),
          ),
          catchError((error) =>
            from(
              (async () => {
                await this.cache.del(lockKey);
                await this.cache.del(cacheKey);
                this.logger.warn(`Idempotency lock released on error: key=${idempotencyKey}`);
              })(),
            ).pipe(switchMap(() => throwError(() => error))),
          ),
        )
        .subscribe({
          next: resolve,
          error: reject,
        });
    });
  }

  private isValidIdempotencyKey(key: string): boolean {
    // The previous `|| (key.length > 0 && key.length <= 255)` fallback made
    // the UUID check meaningless (almost any header value satisfies it),
    // even though the error message and API docs both promise "must be a
    // valid UUID v4". Enforce what's actually documented.
    const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidV4Regex.test(key);
  }
}
