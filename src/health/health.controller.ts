import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { HealthCheck, HealthCheckService, TypeOrmHealthIndicator, MemoryHealthIndicator } from '@nestjs/terminus';
import { ConfigService } from '@nestjs/config';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Public } from '../shared/decorators/public.decorator';

/**
 * Health Check Controller
 * Provides liveness and readiness probes for Kubernetes.
 * Linked to /health endpoint for K8s probes.
 *
 * Deliberately version-neutral and excluded from the global 'api' prefix
 * (see main.ts) — k8s/deployment.yaml's probe paths (/health/live,
 * /health/ready) are a fixed external contract, not part of this API's
 * versioned surface.
 */
@ApiTags('Health')
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly memory: MemoryHealthIndicator,
    private readonly config: ConfigService,
  ) {}

  /**
   * GET /health
   * Comprehensive health check: DB + Memory
   * Used by K8s readiness probe.
   */
  @Get()
  @Public()
  @HealthCheck()
  @ApiOperation({ summary: 'Comprehensive health check (readiness probe)' })
  @ApiResponse({ status: 200, description: 'Terminus HealthCheckResult — database, heap and RSS all within threshold' })
  @ApiResponse({ status: 503, description: 'Terminus HealthCheckResult — at least one indicator is down' })
  async check() {
    // Overridable via env var, defaulting to the values calibrated against
    // k8s/deployment.yaml's real 512Mi pod memory limit — but the e2e test
    // harness runs this same check inside a process that also carries
    // ts-jest's TypeScript compiler and Jest's own machinery, memory a
    // compiled `node dist/main.js` production process never has resident.
    // test/setup-env.ts raises both thresholds for exactly that reason —
    // see docs/technical/ci-cd.md's heap-flake incident for the full story
    // and why this was the actual fix, not sharding or forcing GC.
    // ConfigService.get<number>() doesn't actually cast — an env-var
    // override comes back as a string despite the generic, so this is
    // wrapped in Number() explicitly rather than relying on checkHeap()'s
    // internal `>` comparison to coerce it correctly.
    const heapThresholdBytes = Number(this.config.get('HEALTH_CHECK_HEAP_THRESHOLD_BYTES', 512 * 1024 * 1024));
    const rssThresholdBytes = Number(this.config.get('HEALTH_CHECK_RSS_THRESHOLD_BYTES', 1024 * 1024 * 1024));
    return this.health.check([
      () => this.db.pingCheck('database', { timeout: 3000 }),
      () => this.memory.checkHeap('memory_heap', heapThresholdBytes),
      () => this.memory.checkRSS('memory_rss', rssThresholdBytes),
    ]);
  }

  /**
   * GET /health/live
   * Simple liveness probe - just checks if the process is running.
   */
  @Get('live')
  @Public()
  @ApiOperation({ summary: 'Liveness probe' })
  @ApiResponse({ status: 200, description: 'Process is running' })
  live() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: process.env.APP_VERSION || '1.0.0',
    };
  }

  /**
   * GET /health/ready
   * Readiness probe - checks if service can handle traffic.
   */
  @Get('ready')
  @Public()
  @HealthCheck()
  @ApiOperation({ summary: 'Readiness probe' })
  @ApiResponse({ status: 200, description: 'Terminus HealthCheckResult — database reachable' })
  @ApiResponse({ status: 503, description: 'Terminus HealthCheckResult — database unreachable' })
  async ready() {
    return this.health.check([
      () => this.db.pingCheck('database', { timeout: 3000 }),
    ]);
  }
}
