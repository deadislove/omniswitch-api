using System.Text.RegularExpressions;
using OmniSwitch.Sdk;
using Xunit;

namespace OmniSwitch.Sdk.Tests;

/// <summary>Records every call, replays queued canned responses in order — the mock-HTTP-layer role fetchMock plays in the Node test suite.</summary>
public class RecordingHttpSender : IHttpSender
{
    public record Call(string Method, string Url, IDictionary<string, string> Headers, string? Body);

    public List<Call> Calls { get; } = new();
    private readonly Queue<HttpResult> _responses = new();

    public void Enqueue(int status, string jsonBody) => _responses.Enqueue(new HttpResult(status, jsonBody));

    public Task<HttpResult> SendAsync(string method, string url, IDictionary<string, string> headers, string? body, int timeoutMs)
    {
        Calls.Add(new Call(method, url, new Dictionary<string, string>(headers), body));
        if (_responses.Count == 0)
        {
            throw new InvalidOperationException("No more canned responses queued");
        }
        return Task.FromResult(_responses.Dequeue());
    }
}

public class OmniSwitchClientTests
{
    private static OmniSwitchClient MakeClient(RecordingHttpSender sender) => new(new OmniSwitchClientOptions
    {
        BaseUrl = "https://api.example.com/api/v1",
        ApiKeyId = "ak_test",
        ApiKeySecret = "sk_test",
        HmacSecret = new string('h', 64),
        MerchantId = "merchant_acme",
        HttpSender = sender,
    });

    [Fact]
    public async Task AuthenticatesOnceThenReusesTheCachedTokenForASecondCall()
    {
        var sender = new RecordingHttpSender();
        sender.Enqueue(200, "{\"accessToken\":\"jwt_1\",\"tokenType\":\"Bearer\",\"expiresIn\":3600}");
        sender.Enqueue(200, "{\"paymentId\":\"pay_1\",\"status\":\"SUCCEEDED\"}");
        sender.Enqueue(200, "{\"paymentId\":\"pay_1\",\"status\":\"SUCCEEDED\"}");
        var client = MakeClient(sender);

        await client.GetPaymentAsync("pay_1");
        await client.GetPaymentAsync("pay_1");

        Assert.Equal(3, sender.Calls.Count); // 1 auth + 2 resource calls, no re-auth
        Assert.Equal("https://api.example.com/api/v1/auth/token", sender.Calls[0].Url);
    }

    [Fact]
    public async Task SendsSignatureHeadersOnASignedCallCharge()
    {
        var sender = new RecordingHttpSender();
        sender.Enqueue(200, "{\"accessToken\":\"jwt_1\",\"tokenType\":\"Bearer\",\"expiresIn\":3600}");
        sender.Enqueue(201, "{\"paymentId\":\"pay_1\",\"status\":\"SUCCEEDED\",\"requiresAction\":false,\"usedFallback\":false}");
        var client = MakeClient(sender);

        await client.ChargeAsync(new ChargeParams(10, "USD"));

        var chargeCall = sender.Calls[1];
        Assert.Equal("https://api.example.com/api/v1/payments/charge", chargeCall.Url);
        Assert.NotNull(chargeCall.Headers["X-Signature"]);
        Assert.NotNull(chargeCall.Headers["X-Timestamp"]);
        Assert.Equal("merchant_acme", chargeCall.Headers["X-Merchant-Id"]);
        Assert.Matches(new Regex("^[0-9a-f-]{36}$"), chargeCall.Headers["Idempotency-Key"]);
        Assert.Equal("Bearer jwt_1", chargeCall.Headers["Authorization"]);
    }

    [Fact]
    public async Task DoesNotSignAGetRequestGetPayment()
    {
        var sender = new RecordingHttpSender();
        sender.Enqueue(200, "{\"accessToken\":\"jwt_1\",\"tokenType\":\"Bearer\",\"expiresIn\":3600}");
        sender.Enqueue(200, "{\"paymentId\":\"pay_1\"}");
        var client = MakeClient(sender);

        await client.GetPaymentAsync("pay_1");

        var getCall = sender.Calls[1];
        Assert.False(getCall.Headers.ContainsKey("X-Signature"));
        Assert.False(getCall.Headers.ContainsKey("Idempotency-Key"));
    }

    [Fact]
    public async Task ReusesACallerSuppliedIdempotencyKeyAcrossAnExplicitRetry()
    {
        var sender = new RecordingHttpSender();
        sender.Enqueue(200, "{\"accessToken\":\"jwt_1\",\"tokenType\":\"Bearer\",\"expiresIn\":3600}");
        sender.Enqueue(201, "{\"paymentId\":\"pay_1\"}");
        var client = MakeClient(sender);

        await client.ChargeAsync(new ChargeParams(10, "USD"), "my-fixed-key");

        Assert.Equal("my-fixed-key", sender.Calls[1].Headers["Idempotency-Key"]);
    }

    [Fact]
    public async Task RetriesExactlyOnceWithAFreshTokenOnA401ThenSucceeds()
    {
        var sender = new RecordingHttpSender();
        sender.Enqueue(200, "{\"accessToken\":\"jwt_1\",\"tokenType\":\"Bearer\",\"expiresIn\":3600}");
        sender.Enqueue(401, "{\"statusCode\":401,\"error\":\"Invalid or expired token\",\"code\":\"INVALID_TOKEN\"}");
        sender.Enqueue(200, "{\"accessToken\":\"jwt_2\",\"tokenType\":\"Bearer\",\"expiresIn\":3600}");
        sender.Enqueue(200, "{\"paymentId\":\"pay_1\"}");
        var client = MakeClient(sender);

        var result = await client.GetPaymentAsync("pay_1");

        Assert.Equal("pay_1", result.PaymentId);
        Assert.Equal(4, sender.Calls.Count); // auth, 401, re-auth, success
        Assert.Equal("Bearer jwt_2", sender.Calls[3].Headers["Authorization"]);
    }

    [Fact]
    public async Task ThrowsOmniSwitchApiErrorWithStatusCodeCodeErrorFromTheResponseBody()
    {
        var sender = new RecordingHttpSender();
        sender.Enqueue(200, "{\"accessToken\":\"jwt_1\",\"tokenType\":\"Bearer\",\"expiresIn\":3600}");
        sender.Enqueue(422, "{\"statusCode\":422,\"error\":\"Charge of $50.00 USD exceeds this delegation's per-transaction limit\",\"code\":\"DELEGATION_PER_TRANSACTION_LIMIT_EXCEEDED\"}");
        var client = MakeClient(sender);

        var error = await Assert.ThrowsAsync<OmniSwitchApiError>(() => client.ChargeAsync(new ChargeParams(50, "USD")));
        Assert.Equal(422, error.StatusCode);
        Assert.Equal("DELEGATION_PER_TRANSACTION_LIMIT_EXCEEDED", error.Code);
    }

    [Fact]
    public async Task ThrowsAClearMfaNotSupportedErrorInsteadOfSilentlyReturningARestrictedToken()
    {
        var sender = new RecordingHttpSender();
        sender.Enqueue(200, "{\"accessToken\":\"jwt_pending\",\"tokenType\":\"Bearer\",\"expiresIn\":300,\"mfaRequired\":true}");
        var client = MakeClient(sender);

        var error = await Assert.ThrowsAsync<OmniSwitchApiError>(() => client.GetPaymentAsync("pay_1"));
        Assert.Equal("MFA_NOT_SUPPORTED", error.Code);
    }

    [Fact]
    public async Task RefundCaptureCancelAllSignAndHitTheExpectedPaths()
    {
        var sender = new RecordingHttpSender();
        sender.Enqueue(200, "{\"accessToken\":\"jwt_1\",\"tokenType\":\"Bearer\",\"expiresIn\":3600}");
        sender.Enqueue(200, "{\"paymentId\":\"pay_1\",\"status\":\"REFUNDED\"}");
        sender.Enqueue(200, "{\"paymentId\":\"pay_1\",\"status\":\"SUCCEEDED\"}");
        sender.Enqueue(200, "{\"paymentId\":\"pay_1\",\"status\":\"CANCELLED\"}");
        var client = MakeClient(sender);

        await client.RefundAsync("pay_1", new RefundParams(5.0, null));
        await client.CaptureAsync("pay_1");
        await client.CancelAsync("pay_1");

        Assert.Equal("https://api.example.com/api/v1/payments/pay_1/refund", sender.Calls[1].Url);
        Assert.Equal("https://api.example.com/api/v1/payments/pay_1/capture", sender.Calls[2].Url);
        Assert.Equal("https://api.example.com/api/v1/payments/pay_1/cancel", sender.Calls[3].Url);
        for (var i = 1; i < sender.Calls.Count; i++)
        {
            Assert.NotNull(sender.Calls[i].Headers["X-Signature"]);
        }
    }
}
