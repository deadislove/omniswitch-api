namespace OmniSwitch.Sdk;

public readonly record struct HttpResult(int StatusCode, string Body);

/// <summary>
/// The one seam <see cref="OmniSwitchClient"/> depends on for making HTTP
/// calls — injectable so tests can supply a mock without a real network
/// call, the same role <c>fetch</c> plays in the Node SDK. The default
/// implementation (<see cref="HttpClientSender"/>) uses
/// <see cref="System.Net.Http.HttpClient"/>.
/// </summary>
public interface IHttpSender
{
    Task<HttpResult> SendAsync(
        string method, string url, IDictionary<string, string> headers, string? body, int timeoutMs);
}
