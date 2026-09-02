import { trace, SpanStatusCode, Attributes } from '@opentelemetry/api';

const tracer = trace.getTracer('omniswitch-api');

/**
 * Wraps `fn` in an OpenTelemetry span named `spanName`, as a child of
 * whatever span is currently active (the incoming HTTP request's span, for
 * every call site this is actually used from). Auto-instrumentation (see
 * tracing.ts) already covers the HTTP/DB/Redis/PSP-`fetch` calls
 * underneath `fn` — this exists for the handful of call sites where the
 * *grouping* itself is the thing worth seeing (e.g. "smart routing took
 * 40ms, the PSP charge that followed took 800ms" as two adjacent spans
 * under one checkout, not just an unlabeled flat list of HTTP calls).
 *
 * Always ends the span, and marks it as an error (without swallowing the
 * exception — `fn`'s own rejection still propagates to the caller) so a
 * failed step is visible in a trace, not just a successful one.
 */
export async function traced<T>(
  spanName: string,
  fn: () => Promise<T>,
  attributes?: Attributes,
): Promise<T> {
  return tracer.startActiveSpan(spanName, async (span) => {
    if (attributes) {
      span.setAttributes(attributes);
    }
    try {
      return await fn();
    } catch (err: unknown) {
      span.recordException(err instanceof Error ? err : String(err));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}
