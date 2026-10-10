using System.Text.Json;
using System.Text.Json.Serialization;

namespace OmniSwitch.Sdk;

/// <summary>
/// Deliberately merchant-credential-only in this first cut — an
/// AGENT-delegation client is real future scope this class doesn't cover
/// yet.
/// </summary>
public class OmniSwitchClient
{
    private const int TokenRefreshSkewMs = 30_000;

    private readonly OmniSwitchClientOptions _options;
    private readonly string _baseUrl;
    private readonly IHttpSender _httpSender;
    private readonly JsonSerializerOptions _jsonOptions;
    private readonly SemaphoreSlim _authLock = new(1, 1);
    private CachedToken? _token;

    public OmniSwitchClient(OmniSwitchClientOptions options)
    {
        _options = options;
        _baseUrl = options.BaseUrl.TrimEnd('/');
        _httpSender = options.HttpSender ?? new HttpClientSender();
        _jsonOptions = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        };
    }

    public Task<ChargeResponse> ChargeAsync(ChargeParams parameters, string? idempotencyKey = null)
        => RequestAsync<ChargeResponse>("POST", "/payments/charge", parameters, signed: true, idempotencyKey);

    public Task<PaymentDetail> GetPaymentAsync(string paymentId)
        => RequestAsync<PaymentDetail>("GET", $"/payments/{Uri.EscapeDataString(paymentId)}", null, signed: false, null);

    public Task<RefundResponse> RefundAsync(string paymentId, RefundParams? parameters = null, string? idempotencyKey = null)
        => RequestAsync<RefundResponse>(
            "POST", $"/payments/{Uri.EscapeDataString(paymentId)}/refund", parameters ?? new RefundParams(), signed: true, idempotencyKey);

    public Task<CaptureResponse> CaptureAsync(string paymentId, CaptureParams? parameters = null, string? idempotencyKey = null)
        => RequestAsync<CaptureResponse>(
            "POST", $"/payments/{Uri.EscapeDataString(paymentId)}/capture", parameters ?? new CaptureParams(), signed: true, idempotencyKey);

    public Task<CancelResponse> CancelAsync(string paymentId, string? idempotencyKey = null)
        => RequestAsync<CancelResponse>(
            "POST", $"/payments/{Uri.EscapeDataString(paymentId)}/cancel", new Dictionary<string, object>(), signed: true, idempotencyKey);

    /// <summary>Public so a caller can pre-warm the token or check credentials without making a payments call.</summary>
    public async Task<string> AuthenticateAsync()
    {
        var current = _token;
        if (current != null && current.ExpiresAtMs - TokenRefreshSkewMs > DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())
        {
            return current.AccessToken;
        }

        await _authLock.WaitAsync();
        try
        {
            current = _token;
            if (current != null && current.ExpiresAtMs - TokenRefreshSkewMs > DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())
            {
                return current.AccessToken;
            }

            var body = JsonSerializer.Serialize(
                new { apiKeyId = _options.ApiKeyId, apiKeySecret = _options.ApiKeySecret }, _jsonOptions);
            var headers = new Dictionary<string, string> { ["Content-Type"] = "application/json" };
            var response = await _httpSender.SendAsync("POST", $"{_baseUrl}/auth/token", headers, body, _options.TimeoutMs);

            if (response.StatusCode is < 200 or >= 300)
            {
                throw OmniSwitchApiError.FromResponse(response.StatusCode, response.Body);
            }

            using var parsed = JsonDocument.Parse(response.Body);
            var root = parsed.RootElement;
            if (root.TryGetProperty("mfaRequired", out var mfaProp) && mfaProp.ValueKind == JsonValueKind.True)
            {
                // A pending, MFA-restricted token — this SDK is for
                // server-side integrations authenticating with an API
                // key/secret pair, which shouldn't have MFA enabled on
                // that credential in the first place (MFA guards the
                // human dashboard login path). Surfacing this as a clear
                // error is more useful than silently returning a token
                // every subsequent call would then fail against anyway.
                throw new OmniSwitchApiError(
                    401,
                    "This merchant has MFA enabled — this SDK does not support the MFA challenge flow. Use a credential without MFA enabled for server-side integrations.",
                    "MFA_NOT_SUPPORTED");
            }

            var accessToken = root.GetProperty("accessToken").GetString()!;
            var expiresInSeconds = root.GetProperty("expiresIn").GetInt64();
            _token = new CachedToken(accessToken, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + expiresInSeconds * 1000);
            return accessToken;
        }
        finally
        {
            _authLock.Release();
        }
    }

    private async Task<T> RequestAsync<T>(
        string method, string path, object? bodyObj, bool signed, string? idempotencyKey, bool isRetry = false)
    {
        var accessToken = await AuthenticateAsync();
        var bodyStr = bodyObj != null ? JsonSerializer.Serialize(bodyObj, _jsonOptions) : null;
        var fullPath = $"/api/v1{path}";

        var headers = new Dictionary<string, string>
        {
            ["Content-Type"] = "application/json",
            ["Authorization"] = $"Bearer {accessToken}",
        };

        if (signed)
        {
            var sig = Signing.SignRequest(_options.HmacSecret, method, fullPath, bodyStr ?? "");
            headers["X-Signature"] = sig.Signature;
            headers["X-Timestamp"] = sig.Timestamp;
            headers["X-Merchant-Id"] = _options.MerchantId;
            // Generate a fresh UUID v4 per logical call unless the caller
            // is deliberately retrying the same one — this SDK doesn't
            // retry on its own, so "per call to this method" and "per
            // logical operation" already coincide for a single call.
            headers["Idempotency-Key"] = idempotencyKey ?? Guid.NewGuid().ToString();
        }

        var response = await _httpSender.SendAsync(method, $"{_baseUrl}{path}", headers, bodyStr, _options.TimeoutMs);

        if (response.StatusCode == 401 && _token != null && !isRetry)
        {
            // The cached token may have been revoked server-side
            // (rotation, deactivation) even though it hasn't hit its own
            // expiry yet — exactly one retry with a forced
            // re-authentication, guarded by isRetry so a resource
            // endpoint that 401s even against a freshly issued token
            // can't recurse unboundedly.
            _token = null;
            return await RequestAsync<T>(method, path, bodyObj, signed, idempotencyKey, isRetry: true);
        }

        if (response.StatusCode is < 200 or >= 300)
        {
            throw OmniSwitchApiError.FromResponse(response.StatusCode, response.Body);
        }

        return JsonSerializer.Deserialize<T>(response.Body, _jsonOptions)
            ?? throw new InvalidOperationException("Malformed response body: null after deserialization");
    }

    private sealed record CachedToken(string AccessToken, long ExpiresAtMs);
}
