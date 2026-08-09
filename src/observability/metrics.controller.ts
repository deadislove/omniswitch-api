import { Controller, Get, Header, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Registry, collectDefaultMetrics, Gauge } from 'prom-client';
import { Public } from '../shared/decorators/public.decorator';
import { PaymentProcessorFactory } from '../modules/payment/adapters/psp/payment-processor.factory';
import { LedgerOutboxPort } from '../modules/payment/ports/outbound/ledger-outbox.port';
import { PaymentRepositoryPort } from '../modules/payment/ports/outbound/payment-repository.port';

const CIRCUIT_STATE_VALUE: Record<string, number> = {
  CLOSED: 0,
  HALF_OPEN: 1,
  OPEN: 2,
};

/**
 * Metrics Controller
 * `k8s/deployment.yaml` has carried `prometheus.io/scrape: "true"` /
 * `path: "/metrics"` annotations since this project's early scaffolding —
 * describing an integration that was never actually built. This is that
 * endpoint.
 *
 * Default Node.js/process metrics (memory, event loop lag, GC, CPU) come
 * from `prom-client`'s `collectDefaultMetrics()`. The PSP and outbox gauges
 * below are deliberately *pull-computed* at scrape time (via each Gauge's
 * `collect()` callback) rather than incremented from scattered call sites —
 * both PSP health (`RedisCircuitBreakerService`, via
 * `PaymentProcessorFactory`) and outbox backlog counts already have a
 * single authoritative source of current state, so re-deriving them at
 * scrape time can't drift from it the way manually-maintained counters
 * could.
 *
 * Payment volume (charges by status/provider) follows the exact same
 * pull-computed approach, not an in-process counter incremented from
 * `PaymentCheckoutSaga`'s terminal-outcome branches — see
 * `PaymentRepositoryPort.countByStatusAndProvider()`'s docblock for why
 * that would reintroduce the per-pod-state problem this file's other
 * gauges specifically avoid.
 *
 * Deliberately version-neutral and excluded from the global 'api' prefix
 * (see main.ts) — the Prometheus scrape annotation's path (/metrics) is a
 * fixed external contract, not part of this API's versioned surface.
 */
@ApiExcludeController()
@Controller({ version: VERSION_NEUTRAL })
export class MetricsController {
  private readonly registry = new Registry();

  constructor(
    private readonly processorFactory: PaymentProcessorFactory,
    private readonly ledgerOutbox: LedgerOutboxPort,
    private readonly paymentRepository: PaymentRepositoryPort,
  ) {
    collectDefaultMetrics({ register: this.registry });

    const circuitState = new Gauge({
      name: 'omniswitch_psp_circuit_breaker_state',
      help: 'PSP circuit breaker state (0=CLOSED, 1=HALF_OPEN, 2=OPEN)',
      labelNames: ['provider'],
      registers: [this.registry],
      collect: async () => {
        const statuses = await this.processorFactory.getAllHealthStatuses();
        for (const [provider, status] of statuses) {
          circuitState.set({ provider }, CIRCUIT_STATE_VALUE[status.circuitBreakerState] ?? -1);
        }
      },
    });

    const successRate = new Gauge({
      name: 'omniswitch_psp_success_rate_percent',
      help: 'PSP charge success rate over a rolling 15-minute window (0-100) — see RedisCircuitBreakerService for the bucketing design',
      labelNames: ['provider'],
      registers: [this.registry],
      collect: async () => {
        const statuses = await this.processorFactory.getAllHealthStatuses();
        for (const [provider, status] of statuses) {
          successRate.set({ provider }, status.successRate);
        }
      },
    });

    const avgLatency = new Gauge({
      name: 'omniswitch_psp_avg_latency_ms',
      help: 'PSP average charge latency in milliseconds',
      labelNames: ['provider'],
      registers: [this.registry],
      collect: async () => {
        const statuses = await this.processorFactory.getAllHealthStatuses();
        for (const [provider, status] of statuses) {
          avgLatency.set({ provider }, status.avgLatencyMs);
        }
      },
    });

    new Gauge({
      name: 'omniswitch_ledger_outbox_pending_total',
      help: 'Ledger outbox events currently PENDING (awaiting relay)',
      registers: [this.registry],
      collect: async function (this: Gauge) {
        this.set(await ledgerOutbox.countByStatus('PENDING'));
      },
    });

    new Gauge({
      name: 'omniswitch_ledger_outbox_failed_total',
      help: 'Ledger outbox events dead-lettered as FAILED — see POST /admin/outbox/:id/retry',
      registers: [this.registry],
      collect: async function (this: Gauge) {
        this.set(await ledgerOutbox.countByStatus('FAILED'));
      },
    });

    const paymentVolume = new Gauge({
      name: 'omniswitch_payments_total',
      help: 'Payment volume by terminal-ish status and PSP provider, across every merchant — cumulative since this row first appeared in the payments table, not since process start (see this gauge\'s collect() / PaymentRepositoryPort.countByStatusAndProvider() for why), so rate() over it behaves like a real counter would',
      labelNames: ['status', 'provider'],
      registers: [this.registry],
      collect: async () => {
        const rows = await paymentRepository.countByStatusAndProvider();
        for (const row of rows) {
          paymentVolume.set({ status: row.status, provider: row.pspProvider ?? 'none' }, row.count);
        }
      },
    });
  }

  @Get('metrics')
  @Public()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async metrics(): Promise<string> {
    return this.registry.metrics();
  }
}
