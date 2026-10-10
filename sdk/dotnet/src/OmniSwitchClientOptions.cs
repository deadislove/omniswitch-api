namespace OmniSwitch.Sdk;

public class OmniSwitchClientOptions
{
    /// <summary>e.g. "https://api.example.com/api/v1" — no trailing slash.</summary>
    public required string BaseUrl { get; init; }
    public required string ApiKeyId { get; init; }
    public required string ApiKeySecret { get; init; }
    /// <summary>This merchant's HMAC signing key (from POST /admin/merchants or a rotation call) — never the JWT.</summary>
    public required string HmacSecret { get; init; }
    /// <summary>Business-facing merchant id, sent as X-Merchant-Id on every signed request.</summary>
    public required string MerchantId { get; init; }
    /// <summary>Injectable for tests/non-standard runtimes — defaults to an HttpClient-backed sender.</summary>
    public IHttpSender? HttpSender { get; init; }
    /// <summary>Request timeout, milliseconds. Default 30000.</summary>
    public int TimeoutMs { get; init; } = 30_000;
}
