using System.Text.Json;

namespace OmniSwitch.Sdk;

/// <summary>
/// Every non-2xx OmniSwitch response is shaped <c>{statusCode, error,
/// code}</c> (validation failures add a <c>message</c> array instead of
/// <c>error</c>). <see cref="Code"/> is the stable, machine-readable
/// field meant to be branched on; <c>Message</c>/the raw body are for
/// logging, not string-matching.
/// </summary>
public class OmniSwitchApiError : Exception
{
    public int StatusCode { get; }
    public string? Code { get; }
    public JsonElement? Details { get; }

    public OmniSwitchApiError(int statusCode, string message, string? code = null, JsonElement? details = null)
        : base(message)
    {
        StatusCode = statusCode;
        Code = code;
        Details = details;
    }

    internal static OmniSwitchApiError FromResponse(int statusCode, string rawBody)
    {
        JsonElement? body = null;
        if (!string.IsNullOrEmpty(rawBody))
        {
            try
            {
                body = JsonDocument.Parse(rawBody).RootElement;
            }
            catch (JsonException)
            {
                body = null;
            }
        }

        string? message = null;
        string? code = null;
        if (body is JsonElement element)
        {
            if (element.TryGetProperty("error", out var errorProp) && errorProp.ValueKind == JsonValueKind.String)
            {
                message = errorProp.GetString();
            }
            else if (element.TryGetProperty("message", out var messageProp))
            {
                if (messageProp.ValueKind == JsonValueKind.Array)
                {
                    message = string.Join("; ", messageProp.EnumerateArray().Select(e => e.GetString()));
                }
                else if (messageProp.ValueKind == JsonValueKind.String)
                {
                    message = messageProp.GetString();
                }
            }
            if (element.TryGetProperty("code", out var codeProp) && codeProp.ValueKind == JsonValueKind.String)
            {
                code = codeProp.GetString();
            }
        }
        message ??= $"OmniSwitch API request failed with HTTP {statusCode}";
        return new OmniSwitchApiError(statusCode, message, code, body);
    }
}
