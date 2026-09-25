# OmniSwitch.Sdk (.NET)

A .NET client for the OmniSwitch payment gateway API — the .NET sibling
of [`sdk/node`](../node/), covering the same surface and the same three
things an integrator most reliably gets wrong doing this by hand:

- **HMAC request signing** (`X-Signature`/`X-Timestamp`/`X-Merchant-Id`)
  — computed for you on every charge/refund/capture/cancel call.
- **Idempotency-Key handling** — a fresh UUID v4 per call unless you
  pass one explicitly (to reuse across a retried logical operation).
- **Outbound webhook signature verification** — `Webhooks.VerifyWebhookSignature()`
  checks the `X-OmniSwitch-Signature` header OmniSwitch signs its own
  notifications with.

Auth (`POST /auth/token`) is handled transparently — the first call
obtains a JWT; later calls reuse it until shortly before its expiry,
then re-authenticate automatically.

Published to this repository's own GitHub Packages NuGet registry
(`https://nuget.pkg.github.com/deadislove/index.json`), not NuGet.org —
see [ADR-0007](../../docs/adr/0007-github-packages-publishing.md) for
why.

```bash
dotnet nuget add source --username <your-github-username> --password <a token with read:packages> \
  --store-password-in-clear-text --name github "https://nuget.pkg.github.com/deadislove/index.json"
dotnet add package OmniSwitch.Sdk --source github
```

## Build (within this repo)

```bash
cd sdk/dotnet/test
dotnet test     # unit tests, mocked IHttpSender — no real network call
cd ../src
dotnet build    # produces bin/Debug/net9.0/OmniSwitch.Sdk.dll
```

Targets `net9.0`. Uses `System.Net.Http.HttpClient` and
`System.Text.Json`, both part of the base class library — no external
runtime dependency for the main package.

## Usage

```csharp
using OmniSwitch.Sdk;

var client = new OmniSwitchClient(new OmniSwitchClientOptions
{
    BaseUrl = "https://api.example.com/api/v1",
    ApiKeyId = Environment.GetEnvironmentVariable("OMNISWITCH_API_KEY_ID")!,
    ApiKeySecret = Environment.GetEnvironmentVariable("OMNISWITCH_API_KEY_SECRET")!,
    HmacSecret = Environment.GetEnvironmentVariable("OMNISWITCH_HMAC_SECRET")!,
    MerchantId = "merchant_acme_corp",
});

var charge = await client.ChargeAsync(new ChargeParams(49.99, "USD")
{
    PaymentMethodId = "pm_...", // opaque, client-side-tokenized reference — never a raw card number
    OrderId = "order_12345",
});

if (charge.Status == "SUCCEEDED")
{
    Console.WriteLine($"Charged {charge.PaymentId} via {charge.PspProvider}");
}

// Later, a partial refund of the same charge:
await client.RefundAsync(charge.PaymentId, new RefundParams(10.0, "requested_by_customer"));
```

### Idempotency across a retried operation

```csharp
var idempotencyKey = Guid.NewGuid().ToString();
try
{
    await client.ChargeAsync(parameters, idempotencyKey);
}
catch (HttpRequestException)
{
    // A network failure or timeout — safe to retry with the SAME key.
    await client.ChargeAsync(parameters, idempotencyKey);
}
```

### Verifying an outbound webhook

```csharp
using OmniSwitch.Sdk;

var rawBody = ...; // the exact bytes received — do not re-serialize
var signatureHeader = Request.Headers["X-OmniSwitch-Signature"];

if (!Webhooks.VerifyWebhookSignature(hmacSecret, rawBody, signatureHeader))
{
    return Unauthorized();
}
```

### Error handling

Every non-2xx response throws `OmniSwitchApiError`, exposing the same
stable `Code` field the raw API returns:

```csharp
try
{
    await client.ChargeAsync(parameters);
}
catch (OmniSwitchApiError e) when (e.Code == "DELEGATION_PER_TRANSACTION_LIMIT_EXCEEDED")
{
    // ...
}
```

## What this doesn't cover yet

Same scope limits as `sdk/node`: no agent/delegation credential support,
`MFA_NOT_SUPPORTED` rather than an interactive MFA challenge flow, and
only charge/refund/capture/cancel/get-payment are wrapped — the rest of
the API is real but not yet covered by this client.

**Testing depth vs. `sdk/node`**: this package has the same unit-test
coverage (signing/webhook logic, client HTTP behavior against a mocked
`IHttpSender`), but does **not** yet have a `sdk/node`-style real
end-to-end test driving an actually-running instance of this application
— that layer exists only for the Node SDK today.
