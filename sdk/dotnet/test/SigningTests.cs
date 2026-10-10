using OmniSwitch.Sdk;
using Xunit;

namespace OmniSwitch.Sdk.Tests;

public class SigningTests
{
    [Fact]
    public void ProducesTheExactSignatureHmacSignatureGuardVerifies()
    {
        var secret = new string('a', 64);
        var result = Signing.SignRequest(secret, "post", "/api/v1/payments/charge", "{\"amount\":10}");

        var expected = Signing.HmacSha256Hex(secret, $"{result.Timestamp}.POST./api/v1/payments/charge.{{\"amount\":10}}");
        Assert.Equal(expected, result.Signature);
    }

    [Fact]
    public void UppercasesTheMethodRegardlessOfCallerCasing()
    {
        var secret = new string('a', 64);
        var lower = Signing.SignRequest(secret, "get", "/api/v1/payments/pay_1", "");
        var recomputed = Signing.HmacSha256Hex(secret, $"{lower.Timestamp}.GET./api/v1/payments/pay_1.");
        Assert.Equal(recomputed, lower.Signature);
    }

    [Fact]
    public void ReturnsAUnixSecondsTimestampAsAString()
    {
        var result = Signing.SignRequest("secret", "POST", "/api/v1/payments/charge", "{}");
        Assert.Matches("^\\d+$", result.Timestamp);
        var nowSeconds = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        Assert.True(Math.Abs(nowSeconds - long.Parse(result.Timestamp)) < 5);
    }

    [Fact]
    public void ProducesADifferentSignatureForADifferentBody()
    {
        var secret = new string('a', 64);
        var a = Signing.SignRequest(secret, "POST", "/api/v1/payments/charge", "{\"amount\":10}");
        var b = Signing.SignRequest(secret, "POST", "/api/v1/payments/charge", "{\"amount\":20}");
        Assert.NotEqual(a.Signature, b.Signature);
    }
}
