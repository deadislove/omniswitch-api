import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe, VersioningType, RequestMethod } from '@nestjs/common';
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
  return app;
}
