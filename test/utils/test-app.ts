import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe, VersioningType, RequestMethod } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../../src/app.module';

/**
 * Boots the real application (AppModule, unmodified — no mocked providers)
 * against whatever Postgres/Redis/mock-psp test-app.ts's env points at (see
 * setup-env.ts). Mirrors the parts of main.ts's bootstrap() that affect
 * request handling (validation, versioning, rawBody capture); skips the
 * parts that don't matter for tests (helmet, compression, Swagger UI, the
 * `app.listen()` call itself — supertest talks to app.getHttpServer()
 * directly, no open port needed).
 */
export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication({
    // Same reason as main.ts: HmacSignatureGuard/webhook guards need the
    // exact wire bytes, not a re-serialized JSON.stringify(req.body).
    rawBody: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      errorHttpStatusCode: 422,
    }),
  );
  // Mirrors main.ts's prefix/versioning setup exactly — see that file's
  // comment for why. Kept in sync deliberately, not re-derived.
  app.setGlobalPrefix('api', {
    exclude: [
      { path: 'health', method: RequestMethod.GET },
      { path: 'health/live', method: RequestMethod.GET },
      { path: 'health/ready', method: RequestMethod.GET },
      { path: 'metrics', method: RequestMethod.GET },
    ],
  });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  await app.init();

  // app.init() resolving doesn't guarantee the underlying HTTP adapter's
  // router is done wiring up routes under real system load — a documented,
  // previously-unconfirmed flakiness class (docs/technical/ci-cd.md's
  // "Parallelizing e2e workers" section; a gitignored watchlist note dated
  // 2026-08-24/26) where the very first request against a freshly-booted
  // app (often login() immediately after createTestApp()) intermittently
  // 404s/401s on a route that works everywhere else in the same suite.
  // Confirming a real, always-registered, DB-independent route
  // (/health/live) actually answers before handing the app back closes
  // that specific race without masking it — a genuine 404 on a route that
  // really doesn't exist would still surface immediately on the caller's
  // own first real request.
  for (let attempt = 1; attempt <= 20; attempt++) {
    const res = await request(app.getHttpServer()).get('/health/live');
    if (res.status === 200) break;
    if (attempt === 20) {
      throw new Error(
        `createTestApp(): /health/live never returned 200 after ${attempt} attempts (last status: ${res.status})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return app;
}
