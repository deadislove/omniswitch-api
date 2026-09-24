using System.Security.Cryptography;
using System.Text;

namespace OmniSwitch.Sdk;

/// <summary>
/// Computes the <c>X-Signature</c>/<c>X-Timestamp</c> pair
/// <c>HmacSignatureGuard</c> verifies server-side:
/// <c>HMAC-SHA256(secret, "${timestamp}.${method}.${path}.${rawBody}")</c>,
/// hex digest. <paramref name="path"/> must be the exact request path the
/// server sees, including the <c>/api/v1</c> prefix and query string if
/// any — the guard signs <c>request.originalUrl</c>, not a normalized or
/// query-stripped version. <paramref name="body"/> must be the exact
/// bytes sent on the wire — <see cref="OmniSwitchClient"/> always signs
/// the same JSON string it then sends, never a value re-serialized
/// afterward.
/// </summary>
public static class Signing
{
    public readonly record struct SignResult(string Signature, string Timestamp);

    public static SignResult SignRequest(string secret, string method, string path, string body)
    {
        var timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString();
        var signedPayload = $"{timestamp}.{method.ToUpperInvariant()}.{path}.{body}";
        var signature = HmacSha256Hex(secret, signedPayload);
        return new SignResult(signature, timestamp);
    }

    internal static string HmacSha256Hex(string secret, string payload)
    {
        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(secret));
        var hash = hmac.ComputeHash(Encoding.UTF8.GetBytes(payload));
        return Convert.ToHexString(hash).ToLowerInvariant();
    }
}
