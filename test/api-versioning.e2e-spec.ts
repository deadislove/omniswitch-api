import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { createTestApp } from './utils/test-app';

/**
 * Every controller used to hand-write 'api/v1/...' as its own literal
 * @Controller() path — VersioningType.URI was enabled in main.ts but
 * nothing actually used it. Fixed by having Nest's own
 * setGlobalPrefix('api', {...}) + enableVersioning({ defaultVersion: '1' })
 * generate the prefix/version segments instead. These tests exist because
 * that fix has zero coverage otherwise: every other e2e spec only ever
 * calls the resulting '/api/v1/...' URLs and would pass identically
 * whether Nest generated that prefix or it was still hardcoded text.
 */
describe('API prefix/versioning (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Health and metrics — version-neutral, no /api prefix', () => {
    it('GET /health responds unprefixed (k8s readiness probe contract)', async () => {
      await request(app.getHttpServer()).get('/health').expect(200);
    });

    it('GET /health/live responds unprefixed (k8s liveness probe contract)', async () => {
      const res = await request(app.getHttpServer()).get('/health/live').expect(200);
      expect(res.body.status).toBe('ok');
    });

    it('GET /health/ready responds unprefixed (k8s readiness probe contract)', async () => {
      await request(app.getHttpServer()).get('/health/ready').expect(200);
    });

    it('GET /metrics responds unprefixed (Prometheus scrape annotation contract)', async () => {
      const res = await request(app.getHttpServer()).get('/metrics').expect(200);
      expect(res.text).toContain('# HELP');
    });

    it('health/metrics are not reachable under /api or /api/v1 — they were never meant to be versioned', async () => {
      await request(app.getHttpServer()).get('/api/health').expect(404);
      await request(app.getHttpServer()).get('/api/v1/health').expect(404);
      await request(app.getHttpServer()).get('/api/metrics').expect(404);
      await request(app.getHttpServer()).get('/api/v1/metrics').expect(404);
    });
  });

  describe('Everything else — requires the real /api/v1 prefix', () => {
    it('a real route only resolves under /api/v1, not bare or under /api alone', async () => {
      const body = { apiKeyId: 'bogus', apiKeySecret: 'bogus' };

      // The actual, correct path — reaches the handler (401, not 404).
      const versioned = await request(app.getHttpServer()).post('/api/v1/auth/token').send(body);
      expect(versioned.status).toBe(401);

      // Not reachable without the prefix/version Nest now generates.
      await request(app.getHttpServer()).post('/auth/token').send(body).expect(404);
      await request(app.getHttpServer()).post('/api/auth/token').send(body).expect(404);
      await request(app.getHttpServer()).post('/v1/auth/token').send(body).expect(404);
    });
  });
});
