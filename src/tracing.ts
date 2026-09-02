/**
 * OpenTelemetry bootstrap — must be `import`ed before any other module in
 * this process, `main.ts`'s own first line included (see that file). Auto
 * instrumentation works by monkey-patching modules (`http`, `pg`, `ioredis`,
 * `undici`/`fetch`, ...) at `require()` time via `require-in-the-middle`;
 * anything that imports one of those modules before `NodeSDK.start()` below
 * has run gets the unpatched version, silently, with no error — a payment
 * gateway with no traces is a much easier bug to miss than one that
 * crashes. Node's CommonJS `require()` runs synchronously in declared
 * order, so putting this file's `import` first in `main.ts` is enough;
 * nothing here needs to be `await`ed.
 *
 * `getNodeAutoInstrumentations()` (the `auto-instrumentations-node`
 * meta-package) is what actually covers `pg` (TypeORM's driver), `ioredis`,
 * and Express/Nest's own HTTP layer — but critically also `undici`, not
 * just Node's older `http`/`https` core modules. `StripePSPAdapter`/
 * `AdyenPSPAdapter` call out to their PSP via the global `fetch()`, which
 * is backed by `undici`, not `http` — an instrumentation list that only
 * covered `http`/`https` would trace everything in this app except the one
 * thing most worth tracing (the actual PSP call latency this system's own
 * circuit breaker/smart routing decisions are based on).
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'omniswitch-api',
    [ATTR_SERVICE_VERSION]: process.env.APP_VERSION || '1.0.0',
  }),
  // Defaults to the OTLP/HTTP exporter's own default
  // (http://localhost:4318/v1/traces) when OTEL_EXPORTER_OTLP_ENDPOINT
  // isn't set — matches docker-compose.yml's `jaeger` service (see that
  // file) and needs no configuration for local dev. k8s/configmap.yaml
  // sets this explicitly for a real cluster.
  traceExporter: new OTLPTraceExporter(),
  instrumentations: [
    getNodeAutoInstrumentations({
      // Health checks and the Prometheus scrape itself would otherwise
      // generate a trace every few seconds, forever, drowning out the
      // traces that actually matter (a charge, a webhook, an admin
      // action).
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
});

sdk.start();

// NestJS's own shutdown hooks (app.enableShutdownHooks()) aren't wired up
// in main.ts as of this pass — SIGTERM handling here is independent of
// that, and only responsible for flushing this SDK's own exporter so a
// pod's last few spans before a rolling-update termination aren't lost.
process.on('SIGTERM', () => {
  sdk.shutdown().finally(() => process.exit(0));
});
