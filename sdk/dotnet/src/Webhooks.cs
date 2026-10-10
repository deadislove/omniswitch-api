using System.Security.Cryptography;

namespace OmniSwitch.Sdk;

/// <summary>
/// Verifies the <c>X-OmniSwitch-Signature</c> header OmniSwitch signs its
/// own outbound webhooks with (dispute/subscription/AML-review/sanctions-
/// screening notifications) — <c>t=&lt;unix seconds&gt;,v1=&lt;hex
/// HMAC-SHA256 digest&gt;</c> over <c>"${timestamp}.${rawBody}"</c>,
/// keyed by the same merchant HMAC secret <see cref="Signing.SignRequest"/>
/// uses. This is the verify-side mirror of the server's own signing
/// function.
///
/// <para><paramref name="rawBody"/> must be the exact bytes received on
/// the wire — verifying against a re-serialized payload can silently
/// fail for payloads whose key order or number formatting changes on
/// parse-then-restringify.</para>
///
/// <para>Returns <c>false</c> for a malformed header, an expired
/// timestamp, or a mismatched signature — never throws, so a caller can
/// gate a <c>401</c> response on a single boolean check.</para>
/// </summary>
public static class Webhooks
{
    private const long DefaultToleranceSeconds = 5 * 60;

    public static bool VerifyWebhookSignature(string secret, string rawBody, string? signatureHeader)
        => VerifyWebhookSignature(secret, rawBody, signatureHeader, DefaultToleranceSeconds);

    public static bool VerifyWebhookSignature(
        string secret, string rawBody, string? signatureHeader, long toleranceSeconds)
    {
        if (string.IsNullOrEmpty(signatureHeader))
        {
            return false;
        }

        var parts = new Dictionary<string, string>();
        foreach (var part in signatureHeader.Split(','))
        {
            var kv = part.Split('=', 2);
            if (kv.Length == 2 && kv[0].Length > 0 && kv[1].Length > 0)
            {
                parts[kv[0]] = kv[1];
            }
        }

        if (!parts.TryGetValue("t", out var timestamp) || !parts.TryGetValue("v1", out var providedSignature))
        {
            return false;
        }

        if (!long.TryParse(timestamp, out var timestampSeconds))
        {
            return false;
        }
        var requestTimeMillis = timestampSeconds * 1000;
        var nowMillis = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (Math.Abs(nowMillis - requestTimeMillis) > toleranceSeconds * 1000)
        {
            return false;
        }

        var expectedSignature = Signing.HmacSha256Hex(secret, $"{timestamp}.{rawBody}");

        try
        {
            var expectedBytes = Convert.FromHexString(expectedSignature);
            var providedBytes = Convert.FromHexString(providedSignature);
            return expectedBytes.Length == providedBytes.Length && CryptographicOperations.FixedTimeEquals(expectedBytes, providedBytes);
        }
        catch (FormatException)
        {
            return false;
        }
    }
}
