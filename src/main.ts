// Must be the first import in this file — see tracing.ts's own docblock
// for why (auto-instrumentation patches modules at require() time; any
// import above this one would load unpatched).
import './tracing';

import { NestFactory, Reflector } from '@nestjs/core';
import { ValidationPipe, VersioningType, RequestMethod } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import * as compression from 'compression';
import { AppModule } from './app.module';
import { createLoggerConfig } from './shared/logging/logger.config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    // Buffers the exact bytes of the request body onto `req.rawBody` before
    // body-parser touches it. HmacSignatureGuard needs the untouched wire
    // bytes (not a re-serialized JSON.stringify(req.body)) to verify signatures.
    rawBody: true,
  });

  const configService = app.get(ConfigService);
  const nodeEnv = configService.get<string>('NODE_ENV', 'development');
  const port = configService.get<number>('PORT', 3000);

  // ─── Logger ────────────────────────────────────────────────────────────────
  const logger = createLoggerConfig('omniswitch-api', nodeEnv);
  app.useLogger(logger);

  // ─── Security ──────────────────────────────────────────────────────────────
  app.use(helmet());
  app.use(compression());

  // Enable CORS only for explicitly configured origins.
  // Defaulting to '*' (with credentials: true) would let any website read
  // authenticated responses; if CORS_ORIGINS isn't set, fail closed instead.
  const corsOrigins = configService
    .get<string>('CORS_ORIGINS', '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (corsOrigins.length === 0) {
    logger.warn('CORS_ORIGINS is not configured — cross-origin browser requests will be rejected.');
  }

  app.enableCors({
    origin: corsOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'X-Signature',
      'X-Timestamp',
      'X-Merchant-Id',
      'X-Correlation-Id',
      'X-Request-Id',
    ],
    exposedHeaders: ['X-Correlation-Id', 'X-Request-Id'],
    credentials: true,
  });

  // ─── Validation ────────────────────────────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      errorHttpStatusCode: 422,
    }),
  );

  // ─── API Prefix + Versioning ────────────────────────────────────────────────
  // Nest owns the 'api'/'v1' path segments here — controllers declare only
  // their own resource path (e.g. 'payments'), and defaultVersion: '1'
  // applies '/v1/' to every controller that doesn't explicitly opt out. A
  // real v2 controller can then set its own @Controller({version: '2'})
  // instead of hand-writing a path prefix that Nest's routing has no idea
  // is a version. Health/metrics endpoints are excluded from both — see
  // HealthController/MetricsController's VERSION_NEUTRAL — since
  // k8s/deployment.yaml's probe paths and Prometheus scrape annotation are
  // fixed, unversioned contracts (/health/live, /health/ready, /metrics),
  // not part of this API's own versioned surface.
  app.setGlobalPrefix('api', {
    exclude: [
      { path: 'health', method: RequestMethod.GET },
      { path: 'health/live', method: RequestMethod.GET },
      { path: 'health/ready', method: RequestMethod.GET },
      { path: 'metrics', method: RequestMethod.GET },
    ],
  });
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });

  // ─── Swagger Documentation ──────────────────────────────────────────────────
  if (nodeEnv !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('OmniSwitch Payment Gateway API')
      .setDescription(
        'Enterprise-grade Payment Gateway API Service\n\n' +
        '## Architecture\n' +
        '- **Modular Monolith** + **Hexagonal Architecture** (Ports & Adapters)\n' +
        '- **Domain-Driven Design** with Aggregates, Value Objects, Domain Events\n' +
        '- **Saga Pattern** for multi-step checkout with compensating transactions\n\n' +
        '## Security\n' +
        '- JWT Bearer Authentication\n' +
        '- RBAC (Role-Based Access Control)\n' +
        '- HMAC-SHA256 Request Signature Verification\n' +
        '- Idempotency-Key for duplicate prevention\n' +
        '- Distributed Rate Limiting (100 req/min per merchant)',
      )
      .setVersion('1.0.0')
      .addBearerAuth()
      .addServer(`http://localhost:${port}`, 'Local Development')
      .addServer('https://api.omniswitch.io', 'Production')
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: {
        persistAuthorization: true,
        tagsSorter: 'alpha',
        operationsSorter: 'alpha',
      },
    });
  }

  // ─── Start Server ───────────────────────────────────────────────────────────
  await app.listen(port, '0.0.0.0');

  console.log(`🚀 OmniSwitch Payment Gateway running on port ${port}`);
  console.log(`📚 Swagger docs: http://localhost:${port}/api/docs`);
  console.log(`🏥 Health check: http://localhost:${port}/health`);
  console.log(`🌍 Environment: ${nodeEnv}`);
}

bootstrap().catch((err) => {
  console.error('Failed to start application:', err);
  process.exit(1);
});
