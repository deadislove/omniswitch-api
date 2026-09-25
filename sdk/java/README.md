# omniswitch-sdk (Java)

A Java client for the OmniSwitch payment gateway API — the Java sibling
of [`sdk/node`](../node/), covering the same surface and the same three
things an integrator most reliably gets wrong doing this by hand:

- **HMAC request signing** (`X-Signature`/`X-Timestamp`/`X-Merchant-Id`)
  — computed for you on every charge/refund/capture/cancel call.
- **Idempotency-Key handling** — a fresh UUID v4 per call unless you
  pass one explicitly (to reuse across a retried logical operation).
- **Outbound webhook signature verification** — `Webhooks.verifyWebhookSignature()`
  checks the `X-OmniSwitch-Signature` header OmniSwitch signs its own
  notifications with.

Auth (`POST /auth/token`) is handled transparently — the first call
obtains a JWT; later calls reuse it until shortly before its expiry,
then re-authenticate automatically.

Published to this repository's own GitHub Packages Maven registry
(`https://maven.pkg.github.com/deadislove/omniswitch-api`), not Maven
Central — see
[ADR-0007](../../docs/adr/0007-github-packages-publishing.md) for why.

```xml
<dependency>
  <groupId>io.omniswitch</groupId>
  <artifactId>omniswitch-sdk</artifactId>
  <version>0.1.0</version>
</dependency>
```

Requires a `<repositories>` entry in your own `pom.xml` pointing at the
URL above, plus a `<server>` entry in `~/.m2/settings.xml` for id
`github` authenticated with a GitHub token that has `read:packages` —
see GitHub's own Packages documentation for the exact `settings.xml`
shape for the Maven registry.

## Build (within this repo)

```bash
cd sdk/java
mvn clean test    # unit tests, mocked HttpSender — no real network call
mvn package       # produces target/omniswitch-sdk-0.1.0.jar
```

Requires JDK 11+ and Maven. Uses `java.net.http.HttpClient` (built into
the JDK) for HTTP — no external HTTP library dependency; Jackson is the
one runtime dependency, for JSON (de)serialization.

## Usage

```java
import io.omniswitch.sdk.*;

OmniSwitchClient client = new OmniSwitchClient(
    OmniSwitchClientOptions.builder()
        .baseUrl("https://api.example.com/api/v1")
        .apiKeyId(System.getenv("OMNISWITCH_API_KEY_ID"))
        .apiKeySecret(System.getenv("OMNISWITCH_API_KEY_SECRET"))
        .hmacSecret(System.getenv("OMNISWITCH_HMAC_SECRET"))
        .merchantId("merchant_acme_corp")
        .build());

ChargeParams params = new ChargeParams(49.99, "USD");
params.paymentMethodId = "pm_..."; // opaque, client-side-tokenized reference — never a raw card number
params.orderId = "order_12345";

ChargeResponse charge = client.charge(params);
if ("SUCCEEDED".equals(charge.status)) {
  System.out.println("Charged " + charge.paymentId + " via " + charge.pspProvider);
}

// Later, a partial refund of the same charge:
client.refund(charge.paymentId, new RefundParams(10.0, "requested_by_customer"));
```

### Idempotency across a retried operation

```java
String idempotencyKey = java.util.UUID.randomUUID().toString();
try {
  client.charge(params, idempotencyKey);
} catch (RuntimeException e) {
  // A network failure or timeout — safe to retry with the SAME key.
  client.charge(params, idempotencyKey);
}
```

### Verifying an outbound webhook

```java
import io.omniswitch.sdk.Webhooks;

String rawBody = ...; // the exact bytes received — do not re-serialize
String signatureHeader = request.getHeader("X-OmniSwitch-Signature");

if (!Webhooks.verifyWebhookSignature(hmacSecret, rawBody, signatureHeader)) {
  response.sendError(401, "invalid signature");
  return;
}
```

### Error handling

Every non-2xx response throws `OmniSwitchApiError`, exposing the same
stable `code` field the raw API returns:

```java
try {
  client.charge(params);
} catch (OmniSwitchApiError e) {
  if ("DELEGATION_PER_TRANSACTION_LIMIT_EXCEEDED".equals(e.getCode())) {
    // ...
  }
  throw e;
}
```

## What this doesn't cover yet

Same scope limits as `sdk/node`: no agent/delegation credential support,
`MFA_NOT_SUPPORTED` rather than an interactive MFA challenge flow, and
only charge/refund/capture/cancel/get-payment are wrapped — the rest of
the API is real but not yet covered by this client.

**Testing depth vs. `sdk/node`**: this package has the same unit-test
coverage (signing/webhook logic, client HTTP behavior against a mocked
`HttpSender`), but does **not** yet have a `sdk/node`-style real
end-to-end test driving an actually-running instance of this application
— that layer exists only for the Node SDK today.
