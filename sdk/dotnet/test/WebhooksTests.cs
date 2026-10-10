using OmniSwitch.Sdk;
using Xunit;

namespace OmniSwitch.Sdk.Tests;

public class WebhooksTests
{
    private const string Secret = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // 64 'a's
    private const string Body = "{\"event\":\"dispute.created\",\"paymentId\":\"pay_1\"}";

    private static string Sign(string secret, string body, long? timestampOverride = null)
    {
        var timestamp = timestampOverride ?? DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var signature = Signing.HmacSha256Hex(secret, $"{timestamp}.{body}");
        return $"t={timestamp},v1={signature}";
    }

    [Fact]
    public void AcceptsACorrectlySignedFreshPayload()
        => Assert.True(Webhooks.VerifyWebhookSignature(Secret, Body, Sign(Secret, Body)));

    [Fact]
    public void RejectsAPayloadSignedWithTheWrongSecret()
        => Assert.False(Webhooks.VerifyWebhookSignature(Secret, Body, Sign(new string('b', 64), Body)));

    [Fact]
    public void RejectsAMutatedBodyAgainstASignatureComputedForTheOriginal()
    {
        var header = Sign(Secret, Body);
        Assert.False(Webhooks.VerifyWebhookSignature(Secret, Body + "tampered", header));
    }

    [Fact]
    public void RejectsAMissingSignatureHeader()
    {
        Assert.False(Webhooks.VerifyWebhookSignature(Secret, Body, null));
        Assert.False(Webhooks.VerifyWebhookSignature(Secret, Body, ""));
    }

    [Fact]
    public void RejectsAMalformedHeader()
    {
        Assert.False(Webhooks.VerifyWebhookSignature(Secret, Body, "v1=deadbeef"));
        Assert.False(Webhooks.VerifyWebhookSignature(Secret, Body, "t=1700000000"));
        Assert.False(Webhooks.VerifyWebhookSignature(Secret, Body, "garbage"));
    }

    [Fact]
    public void RejectsATimestampOutsideTheToleranceWindow()
    {
        var staleTimestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds() - 10 * 60;
        var header = Sign(Secret, Body, staleTimestamp);
        Assert.False(Webhooks.VerifyWebhookSignature(Secret, Body, header));
    }

    [Fact]
    public void AcceptsACustomToleranceWindow()
    {
        var timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds() - 60;
        var header = Sign(Secret, Body, timestamp);
        Assert.False(Webhooks.VerifyWebhookSignature(Secret, Body, header, 30));
        Assert.True(Webhooks.VerifyWebhookSignature(Secret, Body, header, 120));
    }

    [Fact]
    public void RejectsANonHexV1ValueWithoutThrowing()
    {
        var header = "t=1700000000,v1=not-hex!!";
        var exception = Record.Exception(() => Webhooks.VerifyWebhookSignature(Secret, Body, header));
        Assert.Null(exception);
        Assert.False(Webhooks.VerifyWebhookSignature(Secret, Body, header));
    }
}
